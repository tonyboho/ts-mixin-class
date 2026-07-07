import type * as ts from "typescript"
import type { ResolvedMixinRef, TransformOptions } from "./model.js"
import type { LinearizationPlanSlice } from "./linearization.js"
import { deepCloneNode } from "./util.js"
import type { TypeScript } from "./util.js"

// The runtime `LinearizationMode` (a magic string) the compiler bakes into the emit, derived
// from the build environment (read in resolveTransformOptions). The plan is ALWAYS emitted;
// the mode only changes what the runtime does with it. Always one of the three explicit
// modes — "verify" (default), "replay" (production), "c3" (escape hatch) — kept here so the
// mixin and consumer emit paths agree.
export function linearizationMode(options: TransformOptions): "verify" | "replay" | "c3" {
    return options.disableLinearizationPlan
        ? "c3"
        : options.verifyLinearization
            ? "verify"
            : "replay"
}

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

// Placeholder entity used when a heritage expression is not a plain reference (an
// identifier or qualified name). This only happens in a transient mid-edit state — e.g.
// a deletion momentarily leaves a `@mixin` class's `implements`/`extends` as a string
// literal or call — which the language service re-transforms on the next keystroke. We
// must NOT throw there (it crashes tsserver mid-typing; the `stress-edit` contract is that
// the transform survives any edit), so we degrade to a placeholder name. It surfaces as a
// transient "cannot find name" at worst, never a crash. The principled entry points
// (`requiredBaseType`, the consumer base guard) still filter unsupported bases via
// `isSupportedBaseExpression`, so a *settled* program never reaches this fallback.
const unsupportedBaseEntityName = "__tsMixinClassUnsupportedBase"

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

    return tsInstance.factory.createIdentifier(unsupportedBaseEntityName)
}

// A local mixin value name is DOTTED when the mixin is referenced through a namespace
// import (`import * as lib` → `localValueName: "lib.Logger"`) — the value expression is
// then a property access off the namespace object, and the type-query form a qualified
// name. A plain name stays a bare identifier. Dots never appear in class names, so the
// split is unambiguous.
function dottedNameToExpression(tsInstance: TypeScript, name: string): ts.Expression {
    const factory = tsInstance.factory

    return name.split(".").map((part): ts.Expression => factory.createIdentifier(part))
        .reduce((expression, part) =>
            factory.createPropertyAccessExpression(expression, (part as ts.Identifier).text))
}

export function dottedNameToEntityName(tsInstance: TypeScript, name: string): ts.EntityName {
    const factory = tsInstance.factory

    return name.split(".").map((part): ts.EntityName => factory.createIdentifier(part))
        .reduce((entityName, part) =>
            factory.createQualifiedName(entityName, (part as ts.Identifier).text))
}

// The dotted text of an all-identifier expression chain (`lib.Logger` → "lib.Logger",
// `Logger` → "Logger"); undefined when any link is not an identifier (a call, an element
// access, `this.…`).
// The EntityName counterpart of `dottedExpressionText` (type positions: `ns.Member`
// as a QualifiedName rather than a PropertyAccessExpression).
export function entityNameText(tsInstance: TypeScript, name: ts.EntityName): string {
    if (tsInstance.isIdentifier(name)) {
        return name.text
    }

    return `${entityNameText(tsInstance, name.left)}.${name.right.text}`
}

export function dottedExpressionText(tsInstance: TypeScript, expression: ts.Expression): string | undefined {
    if (tsInstance.isIdentifier(expression)) {
        return expression.text
    }

    if (tsInstance.isPropertyAccessExpression(expression) && tsInstance.isIdentifier(expression.name)) {
        const base = dottedExpressionText(tsInstance, expression.expression)

        return base === undefined ? undefined : `${base}.${expression.name.text}`
    }

    return undefined
}

export function mixinValueIdentifier(tsInstance: TypeScript, ref: ResolvedMixinRef): ts.Expression {
    if (ref.localValueName === undefined) {
        throw new Error(`Mixin value ${ref.className} is not available in the transformed file`)
    }

    return dottedNameToExpression(tsInstance, ref.localValueName)
}

// Emit a precomputed merge plan as an array-of-triples literal `[[s, o, l], ...]`, the
// runtime `LinearizationPlan` (approach B). The integers ride alone -- the mixin VALUES
// they slice are reached through the dependency arrays already passed alongside the plan.
export function createLinearizationPlanLiteral(
    tsInstance: TypeScript,
    plan: LinearizationPlanSlice[]
): ts.ArrayLiteralExpression {
    const factory = tsInstance.factory

    return factory.createArrayLiteralExpression(
        plan.map((slice) => factory.createArrayLiteralExpression(
            slice.map((value) => factory.createNumericLiteral(value))
        ))
    )
}
