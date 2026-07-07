import type * as ts from "typescript"
import {
    entityNameText,
    createDiagnosticLiteralType,
    dottedNameToEntityName,
    heritageTypeText,
    heritageTypeToTypeReference
} from "./expand-util.js"
import {
    nativeDiagnosticOn,
    DependencyLinearizationError,
    extendsClause,
    metadataBaseLocalName,
    mixinDiagnosticCode,
    requiredBaseType,
    uniqueTypeParameterName,
    type FileMixinContext,
    type RequiredBaseRequirement,
    type RequiredBaseValidation,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { cloneNode, deepCloneNode } from "./util.js"
import { preserveTextRange } from "./text-range.js"
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
        tsInstance, sourceFile, anchor,
        mixinDiagnosticCode.MixinLinearizationConflict,
        message
    ))
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
    options: TransformOptions
): RequiredBaseValidation[] {
    const validations: RequiredBaseValidation[] = []

    for (const ref of mixinRefs) {
        if (options.sourceView && ref.declaration === undefined && ref.requiredBase === undefined) {
            continue
        }

        const requiredBase = requiredBaseRequirementOfMixinRef(tsInstance, context, sourceFile, ref)

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

        const typeParameter = preserveTextRange(tsInstance, tsInstance.factory.createTypeParameterDeclaration(
            undefined,
            uniqueTypeParameterName(declaration, `__mixinRequiredBase${validations.length}`),
            tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
            undefined
        ), generatedRange)

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
            tsInstance, sourceFile, anchor,
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
    ref: ResolvedMixinRef
): RequiredBaseRequirement | undefined {
    if (ref.declaration !== undefined) {
        const requiredBase = requiredBaseType(tsInstance, ref.declaration)

        return requiredBase === undefined ? undefined : {
            typeNode : heritageTypeToTypeReference(tsInstance, requiredBase),
            name     : heritageTypeText(tsInstance, sourceFile, requiredBase)
        }
    }

    if (ref.requiredBase !== undefined) {
        if (ref.requiredBase.import !== undefined) {
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
