import type * as ts from "typescript"
import {
    implementsTypes,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"
import type { ClassFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

// A heritage type whose expression is a bare identifier bound to a mixin known in
// this file's context (so it resolves to a local mixin ref).
function isLocalMixinHeritageType(
    tsInstance: TypeScript,
    heritageType: ts.ExpressionWithTypeArguments,
    context: FileMixinContext
): boolean {
    return tsInstance.isIdentifier(heritageType.expression) &&
        context.byLocalName.has(heritageType.expression.text)
}

export function localMixinHeritageTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return implementsTypes(tsInstance, declaration).filter((heritageType) => {
        return isLocalMixinHeritageType(tsInstance, heritageType, context)
    })
}

export function localMixinHeritageTypesFromFacts(
    tsInstance: TypeScript,
    classFacts: ClassFacts,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return classFacts.implementsTypes.filter((heritageType) => {
        return isLocalMixinHeritageType(tsInstance, heritageType, context)
    })
}

export function localMixinRefs(
    context: FileMixinContext,
    heritageTypes: ts.ExpressionWithTypeArguments[]
): ResolvedMixinRef[] {
    return heritageTypes.map((heritageType) => {
        return context.byLocalName.get((heritageType.expression as ts.Identifier).text)!
    })
}
