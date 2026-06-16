import type * as ts from "typescript"
import {
    anyConstructorName,
    classStaticsName,
    generatedName,
    type MixinDeclarationDiagnostic,
    type ResolvedMixinRef
} from "./model.js"
import {
    cloneNode,
    deepCloneNode,
    generatedTextRange,
    preserveGeneratedDeclarationRange,
    preserveSubtreeTextRange,
    preserveTextRange,
    zeroWidthRange
} from "./util.js"
import type { TypeScript } from "./util.js"

export class MixinTransformError extends Error {
    constructor (sourceFile: ts.SourceFile, node: ts.Node | ts.PropertyName, message: string) {
        const position = nodePosition(sourceFile, node)

        super(`${sourceFile.fileName}${position}: ${message}`)
    }
}

function nodePosition(sourceFile: ts.SourceFile, node: ts.Node): string {
    const start = node.getStart?.(sourceFile)

    if (start === undefined || start < 0) {
        return ""
    }

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)

    return `(${line + 1},${character + 1})`
}

export function createMixinDeclarationDiagnosticAliases(
    tsInstance: TypeScript,
    className: string,
    diagnostics: MixinDeclarationDiagnostic[],
    original: ts.ClassDeclaration
): ts.TypeAliasDeclaration[] {
    const factory = tsInstance.factory

    return diagnostics.map((diagnostic, index) => {
        return preserveGeneratedDeclarationRange(tsInstance, factory.createTypeAliasDeclaration(
            undefined,
            generatedName(className, `$mixinDeclarationError${index}`),
            [ factory.createTypeParameterDeclaration(
                undefined,
                "__mixinDeclarationError",
                factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
                factory.createLiteralTypeNode(factory.createStringLiteral(diagnostic.message))
            ) ],
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
        ), diagnostic.node, original)
    })
}

export function cloneExpressionWithTypeArguments(
    tsInstance: TypeScript,
    expression: ts.ExpressionWithTypeArguments
): ts.ExpressionWithTypeArguments {
    return tsInstance.factory.createExpressionWithTypeArguments(
        deepCloneNode(tsInstance, expression.expression),
        expression.typeArguments?.map((typeArgument) => deepCloneNode(tsInstance, typeArgument))
    )
}

export function heritageTypeToTypeReference(
    tsInstance: TypeScript,
    heritageType: ts.ExpressionWithTypeArguments
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createTypeReferenceNode(
        expressionToEntityName(tsInstance, heritageType.expression),
        heritageType.typeArguments
    )
}

export function heritageTypeText(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    heritageType: ts.ExpressionWithTypeArguments
): string {
    if (heritageType.pos >= 0 && heritageType.end >= 0) {
        return heritageType.getText(sourceFile)
    }

    if (tsInstance.isIdentifier(heritageType.expression) || tsInstance.isPropertyAccessExpression(heritageType.expression)) {
        const typeArguments = heritageType.typeArguments === undefined || heritageType.typeArguments.length === 0
            ? ""
            : "<...>"

        return `${heritageType.expression.getText(sourceFile)}${typeArguments}`
    }

    return "<base class>"
}

export function createDiagnosticLiteralType(
    tsInstance: TypeScript,
    message: string
): ts.LiteralTypeNode {
    return tsInstance.factory.createLiteralTypeNode(tsInstance.factory.createStringLiteral(message))
}

export function expressionToEntityName(tsInstance: TypeScript, expression: ts.Expression): ts.EntityName {
    if (tsInstance.isIdentifier(expression)) {
        return tsInstance.factory.createIdentifier(expression.text)
    }

    if (tsInstance.isPropertyAccessExpression(expression) && tsInstance.isIdentifier(expression.name)) {
        return tsInstance.factory.createQualifiedName(
            expressionToEntityName(tsInstance, expression.expression),
            expression.name.text
        )
    }

    throw new Error("Unsupported base class expression of a mixin consumer")
}

export function mixinValueIdentifier(tsInstance: TypeScript, ref: ResolvedMixinRef): ts.Identifier {
    if (ref.localValueName === undefined) {
        throw new Error(`Mixin value ${ref.className} is not available in the transformed file`)
    }

    return tsInstance.factory.createIdentifier(ref.localValueName)
}

export function createSourceViewConsumerBaseHeadType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined
): ts.TypeNode {
    const factory = tsInstance.factory
    const baseType = extendsType ?? implicitRequiredBase

    if (baseType === undefined) {
        return factory.createTypeQueryNode(factory.createIdentifier(emptyBaseName as string))
    }

    if (baseType.typeArguments === undefined) {
        return factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
    }

    return factory.createIntersectionTypeNode([
        factory.createTypeReferenceNode(anyConstructorName, undefined),
        factory.createTypeReferenceNode(classStaticsName, [
            factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
        ])
    ])
}

export function consumerHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    baseName: string,
    generatedRange: ts.TextRange,
    generatedTypeRange: ts.TextRange = generatedRange,
    extraTypeArguments: ts.TypeNode[] = [],
    keepImplements = true
): ts.NodeArray<ts.HeritageClause> {
    const factory = tsInstance.factory

    const ownTypeArguments = declaration.typeParameters !== undefined && declaration.typeParameters.length > 0
        ? declaration.typeParameters.map((typeParameter): ts.TypeNode => {
            return factory.createTypeReferenceNode(typeParameter.name.text, undefined)
        })
        : []
    const typeArguments = ownTypeArguments.length > 0 || extraTypeArguments.length > 0
        ? [ ...ownTypeArguments, ...extraTypeArguments ]
        : undefined

    const extendsType = preserveTextRange(tsInstance, factory.createExpressionWithTypeArguments(
        factory.createIdentifier(baseName),
        typeArguments
    ), generatedTypeRange)

    if (tsInstance.isExpressionWithTypeArguments(generatedTypeRange as ts.Node)) {
        const originalGeneratedTypeRange = generatedTypeRange as ts.ExpressionWithTypeArguments

        preserveTextRange(tsInstance, extendsType.expression, originalGeneratedTypeRange.expression)

        if (extendsType.typeArguments !== undefined) {
            const generatedTypeArgumentRange = zeroWidthRange(originalGeneratedTypeRange.expression.end)

            preserveTextRange(
                tsInstance,
                extendsType.typeArguments,
                originalGeneratedTypeRange.typeArguments ?? generatedTypeArgumentRange
            )

            extendsType.typeArguments.forEach((typeArgument, index) => {
                const originalTypeArgument = originalGeneratedTypeRange.typeArguments?.[index]

                if (originalTypeArgument !== undefined) {
                    preserveSubtreeTextRange(
                        tsInstance,
                        typeArgument,
                        originalTypeArgument
                    )
                }
            })
        }
    }

    const extendsHeritage = preserveTextRange(tsInstance, factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        extendsType
    ]), generatedRange)

    preserveTextRange(tsInstance, extendsHeritage.types, generatedTypeRange)

    const implementsHeritage = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })
    const clauses = keepImplements && implementsHeritage !== undefined
        ? [ extendsHeritage, implementsHeritage ]
        : [ extendsHeritage ]
    const heritageRange = keepImplements ? declaration.heritageClauses ?? generatedRange : generatedRange

    return preserveTextRange(tsInstance, factory.createNodeArray(clauses), heritageRange)
}
