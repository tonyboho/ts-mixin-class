import type * as ts from "typescript"
import {
    createDiagnosticLiteralType,
    heritageTypeText,
    heritageTypeToTypeReference
} from "./expand-util.js"
import { entityNameText, dottedNameToEntityName } from "./entity-name.js"
import {
    nativeDiagnosticOn,
    DependencyLinearizationError,
    mixinDiagnosticCode,
    type FileMixinContext,
    type RequiredBaseRequirement,
    type RequiredBaseValidation,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { metadataBaseLocalName, uniqueTypeParameterName } from "./naming.js"
import { extendsClause, requiredBaseType } from "./heritage.js"
import { cloneNode, deepCloneNode } from "./util.js"
import { preserveTextRange } from "./text-range.js"
import type { RequiredBaseConflict, RequiredBaseConstraint } from "./required-base-plan.js"
import type { TypeScript } from "./util.js"

// A set of mixins (a consumer's `implements`, or a mixin's own dependencies) that cannot be
// C3-linearized. The conflict is decided by the transformer's own linearization pass, so it is a
// NATIVE diagnostic (family code TS990007), spanned on the offending heritage and drained by
// `wrapProgramDiagnostics` — surfaced identically on the emit and source-view planes. The span is
// gated on a real position (a re-expansion from a synthesized declaration carries synthetic heritage).
export function pushLinearizationConflictDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    context: FileMixinContext,
    anchor: ts.Node,
    message: string
): void {
    if (anchor.pos < 0 || anchor.end < 0) {
        return
    }

    context.nativeDiagnostics.push(nativeDiagnosticOn(
        tsInstance,
        sourceFile,
        anchor,
        mixinDiagnosticCode.MixinLinearizationConflict,
        message
    ))
}

export function pushRequiredBaseConflictDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    context: FileMixinContext,
    anchor: ts.Node,
    conflict: RequiredBaseConflict
): void {
    if (anchor.pos < 0 || anchor.end < 0) {
        return
    }

    context.nativeDiagnostics.push(nativeDiagnosticOn(
        tsInstance,
        sourceFile,
        anchor,
        mixinDiagnosticCode.MixinRequiredBaseConflict,
        requiredBaseConflictDiagnosticMessage(conflict)
    ))
}

export function requiredBaseConflictDiagnosticMessage(conflict: RequiredBaseConflict): string {
    return "Incompatible mixin required bases. " +
        `${conflict.left.mixinName} requires ${conflict.left.baseName}, while ` +
        `${conflict.right.mixinName} requires ${conflict.right.baseName}; ` +
        "neither required base inherits from the other. " +
        "Fix: make one required base extend the other, or do not compose these mixins."
}

export function pushRequiredBaseMismatchDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    context: FileMixinContext,
    anchor: ts.Node,
    consumerName: string,
    actualBaseName: string,
    required: RequiredBaseConstraint
): void {
    if (anchor.pos < 0 || anchor.end < 0) {
        return
    }

    context.nativeDiagnostics.push(nativeDiagnosticOn(
        tsInstance,
        sourceFile,
        anchor,
        mixinDiagnosticCode.MixinRequiredBaseMismatch,
        requiredBaseMismatchDiagnosticMessage(consumerName, actualBaseName, required)
    ))
}

export function requiredBaseMismatchDiagnosticMessage(
    consumerName: string,
    actualBaseName: string,
    required: RequiredBaseConstraint
): string {
    return "Mixin required base mismatch. " +
        `${consumerName} declares base ${actualBaseName}, but ` +
        `${required.mixinName} requires ${required.baseName}. ` +
        `Fix: make ${consumerName}'s base equal to ${required.baseName} or inherit from it.`
}

export function createNominalRequiredBaseValidation(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    generatedRange: ts.TextRange,
    message: string
): RequiredBaseValidation {
    const typeParameter = preserveTextRange(
        tsInstance,
        tsInstance.factory.createTypeParameterDeclaration(
            undefined,
            uniqueTypeParameterName(declaration, "__mixinNominalRequiredBase"),
            tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
            undefined
        ),
        generatedRange
    )

    return {
        typeParameter,
        typeArgument : preserveTextRange(
            tsInstance,
            createDiagnosticLiteralType(tsInstance, message),
            generatedRange
        )
    }
}

export function unsupportedBaseDiagnosticMessage(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const actualBase   = heritageTypeText(tsInstance, sourceFile, extendsType)

    return "Unsupported mixin consumer base expression. " +
        `${consumerName} extends ${actualBase}. ` +
        "Only named base classes such as Base or ns.Base are supported for now. " +
        "Fix: assign the expression to a named class or const and extend that name."
}

export function linearizationDiagnosticMessage(
    directMixinRefs: ResolvedMixinRef[],
    context: FileMixinContext,
    error: DependencyLinearizationError
): string {
    const directMixins = directMixinRefs.map((ref) => ref.className).join(", ")
    const pending      = error.pendingSequences
        .map((sequence) => {
            return sequence.map((key) => context.byKey.get(key)?.className ?? key).join(" -> ")
        })
        .join("; ")

    return "Cannot linearize mixin classes with the C3 algorithm. " +
        `Requested mixins: ${directMixins || "<none>"}. ` +
        `Conflicting order requirements: ${pending || "<unknown>"}. ` +
        "This means the mixins require incompatible inheritance order, for example A before B and B before A. " +
        "Fix it by changing the implements order, removing one conflicting mixin, or splitting the incompatible mixins."
}

export function createRequiredBaseValidations(
    tsInstance: TypeScript,
    context: FileMixinContext,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinRefs: ResolvedMixinRef[],
    generatedRange: ts.TextRange,
    options: TransformOptions,
    // Use-site heritage per DIRECT ref (`implements M<U>` → the `M<U>` node): supplies
    // the type arguments that instantiate a generic mixin's declared base in the
    // consumer's scope. Transitive refs have no use site here — their generic bases
    // degrade to the nominal/runtime checks.
    directHeritageByRef?: ReadonlyMap<ResolvedMixinRef, ts.ExpressionWithTypeArguments>
): RequiredBaseValidation[] {
    const validations: RequiredBaseValidation[] = []

    for (const ref of mixinRefs) {
        if (options.sourceView && ref.declaration === undefined && ref.requiredBase === undefined) {
            continue
        }

        const requiredBase = requiredBaseRequirementOfMixinRef(
            tsInstance,
            context,
            sourceFile,
            ref,
            directHeritageByRef?.get(ref)
        )

        if (requiredBase === undefined) {
            continue
        }

        if (options.sourceView && baseSatisfiesRequiredBaseSyntactically(
            tsInstance,
            sourceFile,
            extendsType,
            requiredBase.typeNode
        )) {
            continue
        }

        const typeParameter = preserveTextRange(
            tsInstance,
            tsInstance.factory.createTypeParameterDeclaration(
                undefined,
                uniqueTypeParameterName(declaration, `__mixinRequiredBase${validations.length}`),
                tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
                undefined
            ),
            generatedRange
        )

        validations.push({
            typeParameter,
            typeArgument : preserveTextRange(
                tsInstance,
                options.sourceView
                    ? createDiagnosticLiteralType(tsInstance, requiredBaseDiagnosticMessage(
                        tsInstance,
                        sourceFile,
                        declaration,
                        extendsType,
                        ref,
                        requiredBase
                    ))
                    : createRequiredBaseDiagnosticType(
                        tsInstance,
                        sourceFile,
                        declaration,
                        extendsType,
                        ref,
                        requiredBase
                    ),
                generatedRange
            )
        })
    }

    return validations
}

// A consumed mixin marked as a runtime mixin class in its `.d.ts` has no JavaScript runtime module
// to apply at runtime. This is resolved entirely from the ref (`ref.missingRuntimeImport`), so it is
// a NATIVE diagnostic (family code TS990006), spanned on the offending `implements` entry and drained
// by `wrapProgramDiagnostics` — surfaced identically on the emit and source-view planes. The span is
// gated on a real position; a construction consumer re-expanded from a synthesized declaration carries
// synthetic heritage (and a missing-runtime ref never reaches that path anyway).
export function pushMissingRuntimeImportDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    mixinRefs: ResolvedMixinRef[],
    mixinHeritage: ts.ExpressionWithTypeArguments[]
): void {
    for (let index = 0; index < mixinRefs.length; index++) {
        const ref = mixinRefs[index]

        if (ref.missingRuntimeImport === undefined) {
            continue
        }

        const anchor = mixinHeritage[index] ?? declaration.name ?? declaration

        if (anchor.pos < 0 || anchor.end < 0) {
            continue
        }

        context.nativeDiagnostics.push(nativeDiagnosticOn(
            tsInstance,
            sourceFile,
            anchor,
            mixinDiagnosticCode.MixinMissingRuntime,
            missingRuntimeImportDiagnosticMessage(declaration, ref)
        ))
    }
}

// The emit path uses a shallow `cloneNode`; source view needs a `deepCloneNode` so the
// reused type parameters carry no shared source positions (the binder reparents a shared
// node onto its last declaration, breaking tsserver name resolution).
function appendValidationTypeParameters(
    tsInstance: TypeScript,
    consumerTypeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    validations: RequiredBaseValidation[],
    clone: (tsInstance: TypeScript, node: ts.TypeParameterDeclaration) => ts.TypeParameterDeclaration
): ts.NodeArray<ts.TypeParameterDeclaration> | undefined {
    const typeParameters = [
        ...(consumerTypeParameters?.map((typeParameter) => clone(tsInstance, typeParameter)) ?? []),
        ...validations.map((validation) => clone(tsInstance, validation.typeParameter))
    ]

    return typeParameters.length === 0 ? undefined : tsInstance.factory.createNodeArray(typeParameters)
}

export function appendRequiredBaseValidationTypeParameters(
    tsInstance: TypeScript,
    consumerTypeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    validations: RequiredBaseValidation[]
): ts.NodeArray<ts.TypeParameterDeclaration> | undefined {
    return appendValidationTypeParameters(tsInstance, consumerTypeParameters, validations, cloneNode)
}

export function appendSourceViewValidationTypeParameters(
    tsInstance: TypeScript,
    consumerTypeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    validations: RequiredBaseValidation[]
): ts.NodeArray<ts.TypeParameterDeclaration> | undefined {
    return appendValidationTypeParameters(tsInstance, consumerTypeParameters, validations, deepCloneNode)
}

function missingRuntimeImportDiagnosticMessage(
    declaration: ts.ClassDeclaration,
    mixinRef: ResolvedMixinRef
): string {
    const consumerName  = declaration.name?.text ?? "<anonymous consumer>"
    const missingImport = mixinRef.missingRuntimeImport

    if (missingImport === undefined) {
        throw new Error("Missing runtime import diagnostic requires missing runtime metadata")
    }

    return "Missing mixin runtime value. " +
        // eslint-disable-next-line max-len
        `Consumer ${consumerName} implements ${mixinRef.className}, and ${mixinRef.className} is marked as a runtime mixin class in declarations from "${missingImport.specifier}". ` +
        "However, the transformer could not find a JavaScript runtime module for that declaration file. " +
        "Mixin classes must be available as runtime values so mixinChain(...) can apply them. " +
        `Fix: publish the JavaScript export for ${mixinRef.className}, expose it from "${missingImport.specifier}", ` +
        `import ${mixinRef.className} as a value, or remove ${mixinRef.className} from the implements list.`
}

function requiredBaseRequirementOfMixinRef(
    tsInstance: TypeScript,
    context: FileMixinContext,
    sourceFile: ts.SourceFile,
    ref: ResolvedMixinRef,
    useSiteHeritage?: ts.ExpressionWithTypeArguments
): RequiredBaseRequirement | undefined {
    if (ref.declaration !== undefined) {
        const requiredBase = requiredBaseType(tsInstance, ref.declaration)

        if (requiredBase === undefined) {
            return undefined
        }

        // A generic mixin's declared base (`@mixin class M<T> extends Base<T>`) references
        // the MIXIN's own type parameters, which do not exist in the consumer's scope —
        // cloned as-is the validation fails with TS2304 on a generated line. Instantiate
        // it from the use site (`implements M<U>` → `Base<U>`) when the arguments are
        // spelled out; otherwise skip this validation — the nominal (checker-side) check
        // and the runtime guard own the case.
        let typeNode            = heritageTypeToTypeReference(tsInstance, requiredBase)
        const ownParameterNames = new Set(
            (ref.declaration.typeParameters ?? []).map((parameter) => parameter.name.text)
        )

        if (ownParameterNames.size > 0 &&
            typeNodeReferencesTypeParameters(tsInstance, typeNode, ownParameterNames)
        ) {
            const substitutions = useSiteTypeParameterSubstitutions(ref.declaration, useSiteHeritage)

            if (substitutions === undefined) {
                return undefined
            }

            typeNode = substituteTypeParameterReferences(tsInstance, typeNode, substitutions)
        }

        return {
            typeNode,
            name : heritageTypeText(tsInstance, sourceFile, requiredBase)
        }
    }

    if (ref.requiredBase !== undefined) {
        if (ref.requiredBase.import !== undefined) {
            // An UNEXPORTED (or unresolvable) cross-file base cannot be imported for the
            // checker-authored validation — emitting the import anyway fails the build
            // with TS2459 on a generated line. Skip this validation; the nominal
            // required-base check (TS990014 path) covers the mismatch without any import.
            const crossFile        = context.crossFile
            const resolvedFileName = crossFile?.resolveModuleFileName(
                ref.requiredBase.import.specifier,
                sourceFile.fileName
            )

            if (crossFile !== undefined && (
                resolvedFileName === undefined ||
                !crossFile.requiredBases.canImportBase(resolvedFileName, ref.requiredBase.import.importedName)
            )) {
                return undefined
            }

            context.usedFactoryImports.set(
                `${ref.requiredBase.import.specifier}:${ref.requiredBase.import.localName}`,
                ref.requiredBase.import
            )
        }

        return {
            typeNode : tsInstance.factory.createTypeReferenceNode(ref.requiredBase.localName, undefined),
            name     : ref.requiredBase.import?.importedName ?? ref.requiredBase.localName
        }
    }

    if (ref.localValueName === undefined) {
        return undefined
    }

    return {
        typeNode : runtimeMixinClassRequiredBaseInstanceType(tsInstance, ref.localValueName),
        name     : `${ref.className} required base`
    }
}

function baseSatisfiesRequiredBaseSyntactically(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    actualBase: ts.ExpressionWithTypeArguments,
    requiredBase: ts.TypeNode,
    seen = new Set<string>()
): boolean {
    const requiredBaseName = typeReferenceNameText(tsInstance, requiredBase)

    if (requiredBaseName === undefined || !tsInstance.isIdentifier(actualBase.expression)) {
        return false
    }

    const actualBaseName = actualBase.expression.text

    if (actualBaseName === requiredBaseName) {
        return true
    }

    if (seen.has(actualBaseName)) {
        return false
    }

    seen.add(actualBaseName)

    const actualBaseDeclaration = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => {
        return tsInstance.isClassDeclaration(statement) && statement.name?.text === actualBaseName
    })
    const nextBase              = actualBaseDeclaration === undefined
        ? undefined
        : extendsClause(tsInstance, actualBaseDeclaration)?.types[0]

    return nextBase === undefined
        ? false
        : baseSatisfiesRequiredBaseSyntactically(tsInstance, sourceFile, nextBase, requiredBase, seen)
}

function typeReferenceNameText(tsInstance: TypeScript, typeNode: ts.TypeNode): string | undefined {
    if (!tsInstance.isTypeReferenceNode(typeNode)) {
        return undefined
    }

    return entityNameText(tsInstance, typeNode.typeName)
}

function createRequiredBaseDiagnosticType(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinRef: ResolvedMixinRef,
    requiredBase: RequiredBaseRequirement
): ts.TypeNode {
    const factory    = tsInstance.factory
    const actualBase = heritageTypeToTypeReference(tsInstance, extendsType)

    return factory.createConditionalTypeNode(
        actualBase,
        cloneNode(tsInstance, requiredBase.typeNode),
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
        factory.createLiteralTypeNode(factory.createStringLiteral(
            requiredBaseDiagnosticMessage(tsInstance, sourceFile, declaration, extendsType, mixinRef, requiredBase)
        ))
    )
}

function requiredBaseDiagnosticMessage(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinRef: ResolvedMixinRef,
    requiredBase: RequiredBaseRequirement
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const actualBase   = heritageTypeText(tsInstance, sourceFile, extendsType)

    return "Mixin required base mismatch. " +
        `Mixin ${mixinRef.className} can only be applied to ${requiredBase.name} or a subclass of ${requiredBase.name}, ` +
        `but ${consumerName} extends ${actualBase}. ` +
        `This requirement comes from ${mixinRef.className} declaring extends ${requiredBase.name}; for mixin classes, ` +
        "extends means a required consumer base, not a fixed runtime base. " +
        `Fix: make ${consumerName} extend ${requiredBase.name} or one of its subclasses, choose a compatible base class, ` +
        `or remove ${mixinRef.className} from the implements list.`
}

function runtimeMixinClassRequiredBaseInstanceType(
    tsInstance: TypeScript,
    valueName: string
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createTypeReferenceNode("InstanceType", [
        factory.createIndexedAccessTypeNode(
            factory.createTypeQueryNode(dottedNameToEntityName(tsInstance, valueName)),
            factory.createTypeQueryNode(factory.createIdentifier(metadataBaseLocalName))
        )
    ])
}

// Whether the type node references any of `names` as a bare type reference — the
// detection side of the generic required-base instantiation above.
function typeNodeReferencesTypeParameters(
    tsInstance: TypeScript,
    node: ts.Node,
    names: ReadonlySet<string>
): boolean {
    if (tsInstance.isTypeReferenceNode(node) &&
        tsInstance.isIdentifier(node.typeName) && names.has(node.typeName.text)
    ) {
        return true
    }

    return tsInstance.forEachChild(node, (child) =>
        typeNodeReferencesTypeParameters(tsInstance, child, names) || undefined) === true
}

// The `implements M<U>` use-site arguments mapped onto M's declared type parameters —
// undefined when the site spells no (or a mismatched number of) arguments, e.g. when
// parameter defaults are relied on: those cases degrade to the nominal/runtime checks.
function useSiteTypeParameterSubstitutions(
    declaration: ts.ClassDeclaration,
    useSiteHeritage: ts.ExpressionWithTypeArguments | undefined
): Map<string, ts.TypeNode> | undefined {
    const parameters = declaration.typeParameters ?? []
    const args       = useSiteHeritage?.typeArguments

    if (args === undefined || args.length !== parameters.length) {
        return undefined
    }

    return new Map(parameters.map((parameter, index) => [ parameter.name.text, args[index]! ]))
}

function substituteTypeParameterReferences(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    substitutions: ReadonlyMap<string, ts.TypeNode>
): ts.TypeNode {
    // `nullTransformationContext` is a real runtime export absent from the public typings
    // (same access pattern as transform-source-file.ts).
    const nullTransformationContext = (tsInstance as unknown as {
        nullTransformationContext : ts.TransformationContext
    }).nullTransformationContext

    const visit = (node: ts.Node): ts.Node => {
        if (tsInstance.isTypeReferenceNode(node) &&
            tsInstance.isIdentifier(node.typeName) && node.typeArguments === undefined
        ) {
            const substitution = substitutions.get(node.typeName.text)

            if (substitution !== undefined) {
                return deepCloneNode(tsInstance, substitution)
            }
        }

        return tsInstance.visitEachChild(node, visit, nullTransformationContext)
    }

    return visit(typeNode) as ts.TypeNode
}
