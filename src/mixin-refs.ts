import type * as ts from "typescript"
import {
    implementsTypes,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"
import type { ClassFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

// The statement list a node introduces as a lexical scope for class declarations. Case /
// default clauses are NOT scopes of their own — every clause of a `switch` shares the one
// case-block scope — so the walk answers at the CaseBlock with all clauses' statements.
function scopeStatements(
    tsInstance: TypeScript,
    node: ts.Node
): readonly ts.Statement[] | undefined {
    if (tsInstance.isSourceFile(node) || tsInstance.isBlock(node) || tsInstance.isModuleBlock(node)) {
        return node.statements
    }

    if (tsInstance.isCaseBlock(node)) {
        return node.clauses.flatMap((clause) => [ ...clause.statements ])
    }

    return undefined
}

// Class declarations are block-scoped: the mixin a heritage identifier means is the one
// declared in the NEAREST enclosing scope, not the first same-named mixin registered in the
// file (`byLocalName` is flat and first-name-wins). The two disagree exactly when scopes hold
// same-named classes with DIFFERENT classifications — e.g. a plain nested class in one
// function shadowing a `@mixin` of the same name in a SIBLING function: the flat lookup would
// expand the plain class's neighbour as a consumer and splice runtime machinery referencing a
// non-mixin (an artifact TS2322 against `RuntimeMixinClassValue` at build, a linearization
// crash at runtime; stress seed 1119868945). The nearest scope DECLARING the name answers —
// with that declaration's ref (a mixin) or with undefined (a plain class: not a mixin
// reference). A name with no same-file declaration in any enclosing scope falls back to the
// by-name entry (an imported mixin).
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

    // Only a file WITH nested classes can shadow: at the top level a same-named second
    // declaration is a duplicate identifier, so the flat by-name entry is already exact.
    if (!context.hasNestedClasses) {
        return byName
    }

    // A synthetic reference has no position to resolve a scope chain from — keep the
    // by-name answer (generated references are only ever emitted for verified refs).
    if (reference.pos < 0 || reference.end <= reference.pos) {
        return byName
    }

    // Descend the context's source file by POSITION CONTAINMENT (program-created files may
    // lack parent pointers, so the walk goes down, not up), recording the same-named class
    // declaration of every scope on the way — the deepest (nearest) one wins.
    const position = reference.end - 1
    let   lexical: ts.ClassDeclaration | undefined

    const visit = (node: ts.Node): void => {
        const statements = scopeStatements(tsInstance, node)

        if (statements !== undefined) {
            for (const statement of statements) {
                if (tsInstance.isClassDeclaration(statement) && statement.name?.text === name) {
                    lexical = statement
                }
            }
        }

        tsInstance.forEachChild(node, (child) => {
            if (child.pos >= 0 && child.pos <= position && position < child.end) {
                visit(child)
            }
        })
    }

    visit(context.sourceFile)

    if (lexical === undefined) {
        return byName
    }

    // An in-place updated declaration (source-view nested expansion mutates statement lists)
    // is keyed in `byDeclaration` by its ORIGINAL node.
    return context.byDeclaration.get(lexical) ??
        context.byDeclaration.get(tsInstance.getOriginalNode(lexical) as ts.ClassDeclaration)
}

export function resolveLocalMixinHeritageRef(
    tsInstance: TypeScript,
    heritageType: ts.ExpressionWithTypeArguments,
    context: FileMixinContext
): ResolvedMixinRef | undefined {
    if (!tsInstance.isIdentifier(heritageType.expression)) {
        return undefined
    }

    return resolveLexicalMixinRef(tsInstance, heritageType, heritageType.expression.text, context)
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
