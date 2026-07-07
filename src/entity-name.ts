import type * as ts from "typescript"
import type { ResolvedMixinRef } from "./model.js"
import type { TypeScript } from "./util.js"

// Conversions between the three spellings of a (possibly qualified) reference: an
// EXPRESSION (`ns.Logger` as property accesses, value position), an ENTITY NAME
// (`ns.Logger` as a QualifiedName, type position), and the dotted TEXT ("ns.Logger",
// the registry / by-name map key). Dots never appear in class names, so the dotted
// split is unambiguous everywhere.

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
