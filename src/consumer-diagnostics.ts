import type * as ts from "typescript"
import {
    createDiagnosticLiteralType,
    heritageTypeText,
    heritageTypeToTypeReference
} from "./expand-util.js"
import {
    DependencyLinearizationError,
    extendsClause,
    metadataBaseLocalName,
    requiredBaseType,
    type FileMixinContext,
    type RequiredBaseRequirement,
    type RequiredBaseValidation,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    cloneNode,
    deepCloneNode,
    preserveTextRange
} from "./util.js"
import type { TypeScript } from "./util.js"

export function createLinearizationDiagnosticValidation(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    message: string,
    generatedRange: ts.TextRange
): RequiredBaseValidation {
    return createConsumerDiagnosticValidation(
        tsInstance,
        declaration,
        "__mixinLinearizationError",
        message,
        generatedRange
    )
}

export function createConsumerDiagnosticValidation(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    parameterBaseName: string,
    message: string,
    generatedRange: ts.TextRange
): RequiredBaseValidation {
    const factory = tsInstance.factory

    return {
        typeParameter : preserveTextRange(tsInstance, factory.createTypeParameterDeclaration(
            undefined,
            uniqueGeneratedTypeParameterName(declaration, parameterBaseName),
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
            undefined
        ), generatedRange),
        typeArgument : preserveTextRange(
            tsInstance,
            factory.createLiteralTypeNode(factory.createStringLiteral(message)),
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
    const actualBase = heritageTypeText(tsInstance, sourceFile, extendsType)

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
    const pending = error.pendingSequences
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
            uniqueGeneratedTypeParameterName(declaration, `__mixinRequiredBase${validations.length}`),
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

export function createMissingRuntimeImportValidations(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    mixinRefs: ResolvedMixinRef[],
    mixinHeritage: ts.ExpressionWithTypeArguments[]
): RequiredBaseValidation[] {
    const validations: RequiredBaseValidation[] = []

    for (let index = 0; index < mixinRefs.length; index++) {
        const ref = mixinRefs[index]

        if (ref.missingRuntimeImport === undefined) {
            continue
        }

        const heritageType = mixinHeritage[index]
        const range = heritageType ?? declaration

        validations.push(createConsumerDiagnosticValidation(
            tsInstance,
            declaration,
            `__mixinMissingRuntimeValue${validations.length}`,
            missingRuntimeImportDiagnosticMessage(declaration, ref),
            range
        ))
    }

    return validations
}

export function appendRequiredBaseValidationTypeParameters(
    tsInstance: TypeScript,
    consumerTypeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    validations: RequiredBaseValidation[]
): ts.NodeArray<ts.TypeParameterDeclaration> | undefined {
    const typeParameters = [
        ...(consumerTypeParameters?.map((typeParameter) => cloneNode(tsInstance, typeParameter)) ?? []),
        ...validations.map((validation) => cloneNode(tsInstance, validation.typeParameter))
    ]

    return typeParameters.length === 0 ? undefined : tsInstance.factory.createNodeArray(typeParameters)
}

export function appendSourceViewValidationTypeParameters(
    tsInstance: TypeScript,
    consumerTypeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    validations: RequiredBaseValidation[]
): ts.NodeArray<ts.TypeParameterDeclaration> | undefined {
    const typeParameters = [
        ...(consumerTypeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter)) ?? []),
        ...validations.map((validation) => deepCloneNode(tsInstance, validation.typeParameter))
    ]

    return typeParameters.length === 0 ? undefined : tsInstance.factory.createNodeArray(typeParameters)
}

function missingRuntimeImportDiagnosticMessage(
    declaration: ts.ClassDeclaration,
    mixinRef: ResolvedMixinRef
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const missingImport = mixinRef.missingRuntimeImport

    if (missingImport === undefined) {
        throw new Error("Missing runtime import diagnostic requires missing runtime metadata")
    }

    return "Missing mixin runtime value. " +
        `Consumer ${consumerName} implements ${mixinRef.className}, and ${mixinRef.className} is marked as a runtime mixin class in declarations from "${missingImport.specifier}". ` +
        "However, the transformer could not find a JavaScript runtime module for that declaration file. " +
        "Mixin classes must be available as runtime values so mixinChain(...) can apply them. " +
        `Fix: publish the JavaScript export for ${mixinRef.className}, expose it from "${missingImport.specifier}", ` +
        `import ${mixinRef.className} as a value, or remove ${mixinRef.className} from the implements list.`
}

function uniqueGeneratedTypeParameterName(
    declaration: ts.ClassDeclaration,
    baseName: string
): string {
    const existing = new Set(declaration.typeParameters?.map((typeParameter) => typeParameter.name.text) ?? [])
    let name = baseName
    let index = 0

    while (existing.has(name)) {
        index++
        name = `${baseName}_${index}`
    }

    return name
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
    const nextBase = actualBaseDeclaration === undefined
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

function entityNameText(tsInstance: TypeScript, name: ts.EntityName): string {
    if (tsInstance.isIdentifier(name)) {
        return name.text
    }

    return `${entityNameText(tsInstance, name.left)}.${name.right.text}`
}

function createRequiredBaseDiagnosticType(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinRef: ResolvedMixinRef,
    requiredBase: RequiredBaseRequirement
): ts.TypeNode {
    const factory = tsInstance.factory
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
    const actualBase = heritageTypeText(tsInstance, sourceFile, extendsType)

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
            factory.createTypeQueryNode(factory.createIdentifier(valueName)),
            factory.createTypeQueryNode(factory.createIdentifier(metadataBaseLocalName))
        )
    ])
}
