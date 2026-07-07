import type * as ts from "typescript"
import type { TypeScript } from "./util.js"

// Readers of a class declaration's heritage clauses — the AST-reading counterpart of the
// heritage BUILDERS (consumer-base-heritage.ts / mixin-factory.ts). `requiredBaseType`
// is the principled entry: it filters unsupported base expressions (calls, mid-edit
// artifacts) via `isSupportedBaseExpression`, so downstream code never throws on them.

export function implementsTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.ExpressionWithTypeArguments[] {
    const clause = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })

    return clause === undefined ? [] : [ ...clause.types ]
}

// A runtime base must be a plain entity name (an identifier or a dotted access),
// the only forms the transform can turn into `typeof Base` / a heritage
// reference. Anything else — a call expression, or the `{` body brace parsed as
// an object literal while `extends` is being typed in tsserver — is not a usable
// base. `requiredBaseType` treats those as "no base" so the whole transform
// degrades gracefully rather than throwing (a throwing ProgramTransformer crashes
// the program build and sticks tsserver with the untransformed fallback).
export function isSupportedBaseExpression(tsInstance: TypeScript, expression: ts.Expression): boolean {
    if (tsInstance.isIdentifier(expression)) {
        return true
    }

    return tsInstance.isPropertyAccessExpression(expression) &&
        tsInstance.isIdentifier(expression.name) &&
        isSupportedBaseExpression(tsInstance, expression.expression)
}

export function requiredBaseType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.ExpressionWithTypeArguments | undefined {
    const base = extendsClause(tsInstance, declaration)?.types[0]

    return base !== undefined && isSupportedBaseExpression(tsInstance, base.expression)
        ? base
        : undefined
}

export function requiredBaseIdentifierName(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): string | undefined {
    const requiredBase = requiredBaseType(tsInstance, declaration)

    return requiredBase !== undefined && tsInstance.isIdentifier(requiredBase.expression)
        ? requiredBase.expression.text
        : undefined
}

export function extendsClause(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.HeritageClause | undefined {
    return declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })
}
