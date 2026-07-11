import type * as ts from "typescript"
import { expressionToEntityName } from "./entity-name.js"
import { deepCloneNode } from "./util.js"
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

export function cloneExpressionWithTypeArguments(
    tsInstance: TypeScript,
    expression: ts.ExpressionWithTypeArguments
): ts.ExpressionWithTypeArguments {
    return tsInstance.factory.createExpressionWithTypeArguments(
        deepCloneNode(tsInstance, expression.expression),
        expression.typeArguments?.map((typeArgument) => deepCloneNode(tsInstance, typeArgument))
    )
}

// A single type is returned as-is; two or more are wrapped in an intersection. Callers
// pass a non-empty list (a head type plus optional extras), so the empty case is not
// expected — kept here as the one place that decides "intersect only when needed".
export function intersectionOrSingle(
    tsInstance: TypeScript,
    types: ts.TypeNode[]
): ts.TypeNode {
    return types.length === 1 ? types[0] : tsInstance.factory.createIntersectionTypeNode(types)
}

// Walk `typeNode`, replacing each bare type reference (an identifier type name with no
// type arguments) for which `replace` returns a node; references `replace` maps to
// `undefined` are left as-is. Returns a position-less rewritten type. Shared by the
// mixin's own-type-parameter erasure (-> `any`) and the consumer config substitution
// (-> the consumer's `implements` type argument).
export function rewriteTypeReferences(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    replace: (name: string) => ts.TypeNode | undefined
): ts.TypeNode {
    const result = tsInstance.transform(typeNode, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                if (tsInstance.isTypeReferenceNode(node) &&
                    tsInstance.isIdentifier(node.typeName) &&
                    node.typeArguments === undefined) {
                    const replacement = replace(node.typeName.text)

                    if (replacement !== undefined) {
                        return replacement
                    }
                }

                return tsInstance.visitEachChild(node, visit, context)
            }

            return (node) => tsInstance.visitNode(node, visit) as ts.TypeNode
        }
    ])

    try {
        return result.transformed[0]
    } finally {
        result.dispose()
    }
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

// Whether the type node references any of `names` as a bare type reference — the
// detection side of generic required-base instantiation.
export function typeNodeReferencesTypeParameters(
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

// Every type-reference NAME inside `node` — or undefined when a non-identifier type name
// (a qualified `ns.Type`) appears, which callers treat as "cannot reason about the scope
// this node needs". Used to decide whether a type node can be transplanted into another
// scope after substituting the listed parameters.
export function collectTypeReferenceNames(
    tsInstance: TypeScript,
    node: ts.Node,
    names = new Set<string>()
): Set<string> | undefined {
    if (tsInstance.isTypeReferenceNode(node)) {
        if (!tsInstance.isIdentifier(node.typeName)) {
            return undefined
        }

        names.add(node.typeName.text)
    }

    const failed = tsInstance.forEachChild(node, (child) =>
        collectTypeReferenceNames(tsInstance, child, names) === undefined || undefined)

    return failed === true ? undefined : names
}

// The `implements M<U>` use-site arguments mapped onto M's declared type parameters —
// undefined when the site spells no (or a mismatched number of) arguments, e.g. when
// parameter defaults are relied on: those cases degrade to the nominal/runtime checks.
export function useSiteTypeParameterSubstitutions(
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

export function substituteTypeParameterReferences(
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
