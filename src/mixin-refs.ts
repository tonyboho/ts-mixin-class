import type * as ts from "typescript"
import { dottedExpressionText } from "./expand-util.js"
import {
    implementsTypes,
    type ClassScopeEntry,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"
import type { ClassFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

// Class declarations are block-scoped: the mixin a heritage identifier means is the one
// declared in the NEAREST enclosing scope, not the first same-named mixin registered in the
// file (`byLocalName` is flat and first-name-wins). The two disagree exactly when scopes hold
// same-named classes with DIFFERENT classifications — e.g. a plain nested class in one
// function shadowing a `@mixin` of the same name in a SIBLING function: the flat lookup would
// expand the plain class's neighbour as a consumer and splice runtime machinery referencing a
// non-mixin (an artifact TS2322 against `RuntimeMixinClassValue` at build, a linearization
// crash at runtime; stress seed 1119868945). Resolution answers from the facts pass's
// `classScopesByName` index — the deepest same-named declaration whose scope CONTAINS the
// reference — in O(same-named entries), no tree walk. The declaration's ref (a mixin) or
// undefined (a plain class: not a mixin reference); a name with no same-file declaration in
// any enclosing scope falls back to the by-name entry (an imported mixin).
export function resolveLexicalMixinRef(
    tsInstance: TypeScript,
    reference: ts.Node,
    name: string,
    context: FileMixinContext
): ResolvedMixinRef | undefined {
    const byName = context.byLocalName.get(name)

    if (byName === undefined) {
        return undefined
    }

    const entries = context.classScopesByName.get(name)

    // No same-file declaration of the name at all — the by-name entry (an import) is exact.
    if (entries === undefined) {
        return byName
    }

    // A synthetic reference has no position to resolve a scope chain from — keep the
    // by-name answer (generated references are only ever emitted for verified refs).
    if (reference.pos < 0 || reference.end <= reference.pos) {
        return byName
    }

    const position = reference.end - 1
    let   lexical: ClassScopeEntry | undefined

    for (const entry of entries) {
        if (entry.scopeStart <= position && position < entry.scopeEnd &&
            (lexical === undefined || entry.depth >= lexical.depth)
        ) {
            lexical = entry
        }
    }

    return lexical === undefined ? byName : context.byDeclaration.get(lexical.declaration)
}

export function resolveLocalMixinHeritageRef(
    tsInstance: TypeScript,
    heritageType: ts.ExpressionWithTypeArguments,
    context: FileMixinContext
): ResolvedMixinRef | undefined {
    if (tsInstance.isIdentifier(heritageType.expression)) {
        return resolveLexicalMixinRef(tsInstance, heritageType, heritageType.expression.text, context)
    }

    // A QUALIFIED reference (`implements lib.Logger` through `import * as lib`) is keyed in
    // `byLocalName` by its dotted text. No lexical walk: a dotted name has no same-file class
    // declaration to shadow it (the namespace binding itself is an import).
    if (tsInstance.isPropertyAccessExpression(heritageType.expression)) {
        const dotted = dottedExpressionText(tsInstance, heritageType.expression)

        return dotted === undefined ? undefined : context.byLocalName.get(dotted)
    }

    return undefined
}

export function localMixinHeritageTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return implementsTypes(tsInstance, declaration).filter((heritageType) => {
        return resolveLocalMixinHeritageRef(tsInstance, heritageType, context) !== undefined
    })
}

export function localMixinHeritageTypesFromFacts(
    tsInstance: TypeScript,
    classFacts: ClassFacts,
    context: FileMixinContext
): ts.ExpressionWithTypeArguments[] {
    return classFacts.implementsTypes.filter((heritageType) => {
        return resolveLocalMixinHeritageRef(tsInstance, heritageType, context) !== undefined
    })
}

export function localMixinRefs(
    tsInstance: TypeScript,
    context: FileMixinContext,
    heritageTypes: ts.ExpressionWithTypeArguments[]
): ResolvedMixinRef[] {
    return heritageTypes.map((heritageType) => {
        return resolveLocalMixinHeritageRef(tsInstance, heritageType, context)!
    })
}
