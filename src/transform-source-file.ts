import type * as ts from "typescript"
import { expandConsumerClass } from "./consumer-expand.js"
import { expandConstructionBaseClass } from "./construction-base-expand.js"
import {
    importsPackageBase,
    isConstructionBaseOptIn,
    resolveCrossFileConstructionBase
} from "./construction-chain.js"
import { buildFileMixinContext } from "./context.js"
import { hasMixinDecorator } from "./decorators.js"
import { dottedExpressionText } from "./entity-name.js"
import {
    collectReferencedIdentifierNames,
    insertGeneratedImports,
    pruneConsumedDecoratorImports,
    referencedNameQueries
} from "./generated-imports.js"
import { buildImportedNameMap } from "./import-map.js"
import { pushManualMixinApplicationDiagnostics } from "./mixin-diagnostics.js"
import { expandMixinClass } from "./mixin-expand.js"
import {
    pushMixinMemberKindOverrideDiagnostics,
    pushMixinNamespaceMergeDiagnostics,
    pushMixinUsedBeforeDeclarationDiagnostics,
    pushPartialAccessorOverrideDiagnostics
} from "./mixin-override-diagnostics.js"
import { localMixinHeritageTypesFromFacts, resolveLocalMixinHeritageRef } from "./mixin-refs.js"
import {
    type ImportMap,
    nativeDiagnosticOn,
    defaultTransformOptions,
    mixinDiagnosticCode,
    type CrossFileContext,
    type FileMixinContext,
    type MixinDecoratorImports,
    type NativeMixinDiagnostic,
    type TransformOptions
} from "./model.js"
import { implementsTypes } from "./heritage.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import { cloneSourceFileForTransform } from "./source-file-clone.js"
import type { TypeScript } from "./util.js"

// The per-file transform: expands every mixin / consumer / construction-base class in a
// source file (including ones nested in blocks), pushes the file-scoped native diagnostics,
// and manages the generated imports. `transformAppliesToSourceFile` is the cheap gate the
// compiler host (`compiler-host.ts`) asks before cloning anything; `transformProgram`
// (index.ts) wires the whole pipeline together.

export function transformSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: Partial<TransformOptions> = {},
    crossFile?: CrossFileContext,
    nativeDiagnostics: NativeMixinDiagnostic[] = []
): ts.SourceFile {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    if (!transformAppliesToSourceFile(tsInstance, sourceFile, resolvedOptions, crossFile)) {
        return sourceFile
    }

    let facts = getSourceFileFacts(tsInstance, sourceFile, resolvedOptions)

    // Source-view nested expansion mutates a block's `statements` IN PLACE (see
    // `expandNestedStatementLists`), so the input source file must be owned by this call. The
    // compiler host already passes a per-call clone, but a direct caller may pass a live, reused
    // source file (e.g. an incrementally-updated editor buffer in stress-edit) — mutating that
    // would corrupt it. Re-parse a private clone here and re-derive facts on it, so the transform
    // never mutates its argument. Scoped to source-view-with-nested-classes (rare); other paths
    // rebuild rather than mutate, and so never touch the input.
    if (resolvedOptions.sourceView && facts.hasNestedClasses) {
        sourceFile = cloneSourceFileForTransform(tsInstance, sourceFile, sourceFile.languageVersion)
        facts      = getSourceFileFacts(tsInstance, sourceFile, resolvedOptions)
    }

    const mixinDecoratorImports = facts.mixinDecoratorImports
    const context               = buildFileMixinContext(
        tsInstance,
        sourceFile,
        mixinDecoratorImports,
        resolvedOptions,
        crossFile,
        facts,
        nativeDiagnostics
    )

    pushAnonymousClassExpressionDiagnostics(tsInstance, sourceFile, facts, context, mixinDecoratorImports, resolvedOptions)
    pushManualMixinApplicationDiagnostics(tsInstance, sourceFile, context)

    // Resolves local base identifiers to cross-file construction-base entries.
    // Built lazily, only when a class actually needs construction-base resolution.
    let baseImportMapCache: ImportMap | undefined
    const getBaseImportMap = (): ImportMap | undefined => {
        if (crossFile === undefined) {
            return undefined
        }

        // eslint-disable-next-line align-assignments/align-assignments
        baseImportMapCache ??= buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName, facts)

        return baseImportMapCache
    }

    let expandedAnything      = false
    let needsGeneratedImports = false

    const expandClassStatement = (statement: ts.Statement, siblings: readonly ts.Statement[]): ts.Statement[] => {
        const classFacts = tsInstance.isClassDeclaration(statement)
            ? facts.classesByDeclaration.get(statement)
            : undefined

        if (classFacts !== undefined) {
            pushMixinUsedBeforeDeclarationDiagnostics(tsInstance, sourceFile, context, classFacts, statement, siblings)
            pushMixinMemberKindOverrideDiagnostics(tsInstance, sourceFile, facts, context, resolvedOptions, classFacts, statement)
            pushPartialAccessorOverrideDiagnostics(tsInstance, sourceFile, facts, context, classFacts, statement)
        }

        // Anonymous `@mixin` / anonymous mixin consumer: a NATIVE diagnostic (drained by the
        // diagnostic wrap), pushed once and the class left in place — no `expandedAnything`, so a
        // file whose only finding is this needs no reprint.
        if (classFacts !== undefined && classFacts.name === undefined && classFacts.hasMixinDecorator) {
            context.nativeDiagnostics.push(anonymousClassNativeDiagnostic(
                tsInstance,
                sourceFile,
                classFacts.declaration,
                mixinDiagnosticCode.AnonymousDefaultMixin,
                "Invalid mixin class declaration. A default-exported mixin class must be named. " +
                    "Write `export default class MyMixin` so the transformer can generate stable interface, factory, registry, and declaration names."
            ))
            return [ statement ]
        }

        if (classFacts !== undefined && classFacts.name === undefined &&
            localMixinHeritageTypesFromFacts(tsInstance, classFacts, context).length > 0
        ) {
            context.nativeDiagnostics.push(anonymousClassNativeDiagnostic(
                tsInstance,
                sourceFile,
                classFacts.declaration,
                mixinDiagnosticCode.AnonymousMixinConsumer,
                "Invalid mixin consumer declaration. A mixin consumer class must be named. " +
                    "Write `class Consumer implements Mixin` or `export default class Consumer implements Mixin` " +
                    "so the transformer can generate stable intermediate base, diagnostic, and declaration names."
            ))
            return [ statement ]
        }

        if (classFacts !== undefined && classFacts.name !== undefined) {
            const ref = context.byDeclaration.get(classFacts.declaration)

            if (ref !== undefined) {
                expandedAnything      = true
                needsGeneratedImports = true
                return expandMixinClass(tsInstance, sourceFile, ref, context, resolvedOptions)
            }

            const mixinHeritage = localMixinHeritageTypesFromFacts(tsInstance, classFacts, context)

            if (mixinHeritage.length > 0) {
                expandedAnything      = true
                needsGeneratedImports = true
                return expandConsumerClass(tsInstance, sourceFile, classFacts.declaration, context, resolvedOptions, mixinHeritage)
            }

            if (isConstructionBaseOptIn(
                tsInstance,
                sourceFile,
                classFacts.extendsType,
                resolvedOptions,
                facts,
                new Set(),
                crossFile,
                getBaseImportMap()
            )) {
                const expandedStatements = expandConstructionBaseClass(
                    tsInstance,
                    sourceFile,
                    classFacts.declaration,
                    resolvedOptions,
                    crossFile,
                    getBaseImportMap()
                )

                if (expandedStatements.length !== 1 || expandedStatements[0] !== statement) {
                    expandedAnything = true
                    return expandedStatements
                }
            }
        }

        return [ statement ]
    }

    // Expand each statement in a list, then recurse into the nested statement lists of whatever
    // comes back, so a mixin / consumer declared inside a function body or block expands too.
    // The generated siblings land in the SAME list as the class (its containing block), never
    // hoisted to module scope. No-op-safe: when nothing in a list expands or nests, the original
    // array reference flows back unchanged, so the position-preserved source-view tree is never
    // rebuilt.
    const expandStatementList = (statements: readonly ts.Statement[]): readonly ts.Statement[] => {
        let changed               = false
        const out: ts.Statement[] = []

        for (const statement of statements) {
            const expanded = expandClassStatement(statement, statements)

            if (expanded.length !== 1 || expanded[0] !== statement) {
                changed = true
            }

            for (const expandedStatement of expanded) {
                const recursed = expandNestedStatementLists(expandedStatement)

                if (recursed !== statement) {
                    changed = true
                }

                out.push(recursed)
            }
        }

        return changed ? out : statements
    }

    // Reach the nested statement lists (`Block`, `ModuleBlock`) inside `node` and expand them.
    //
    // SOURCE VIEW mutates each block's `statements` IN PLACE (the input is a per-call clone, so
    // this is safe): the user's function / block ancestors keep their node identity — and so their
    // binding and `.original`-free state. Rebuilding them with `visitEachChild` instead would set
    // `.original` to the pre-transform node, which TS's syntactic node builder then follows to an
    // un-bound node and crashes on, both in display-part serialization AND declaration emit.
    //
    // EMIT cannot mutate (its input is the shared host source file), so it rebuilds with
    // `visitEachChild`; the reprint path never reaches the syntactic node builder, so `.original`
    // on a rebuilt ancestor is harmless there.
    const expandNestedStatementLists = (node: ts.Statement): ts.Statement => {
        if (resolvedOptions.sourceView) {
            mutateNestedStatementLists(node)

            return node
        }

        const visit = (inner: ts.Node): ts.Node => {
            if (tsInstance.isBlock(inner)) {
                const statements = expandStatementList(inner.statements)

                return statements === inner.statements
                    ? inner
                    : tsInstance.factory.updateBlock(inner, statements)
            }

            if (tsInstance.isModuleBlock(inner)) {
                const statements = expandStatementList(inner.statements)

                return statements === inner.statements
                    ? inner
                    : tsInstance.factory.updateModuleBlock(inner, statements)
            }

            // A `switch` case / default clause owns a statement list that is NOT a `Block`;
            // a class declared directly in the clause splices into that list the same way.
            if (tsInstance.isCaseClause(inner)) {
                const statements = expandStatementList(inner.statements)

                return statements === inner.statements
                    ? inner
                    : tsInstance.factory.updateCaseClause(inner, inner.expression, statements)
            }

            if (tsInstance.isDefaultClause(inner)) {
                const statements = expandStatementList(inner.statements)

                return statements === inner.statements
                    ? inner
                    : tsInstance.factory.updateDefaultClause(inner, statements)
            }

            // A transient mid-edit tree can hold a node `visitEachChild`'s own Debug
            // assertions reject (e.g. a half-typed `[` member parsing as an index
            // signature with no type). Skip descending such a subtree for this keystroke
            // — a nested class inside it simply stays unexpanded until the next complete
            // parse; throwing would crash the whole program build in tsserver.
            try {
                return tsInstance.visitEachChild(inner, visit, nullTransformationContext)
            } catch {
                return inner
            }
        }

        return visit(node) as ts.Statement
    }

    // Source-view in-place block expansion (see `expandNestedStatementLists`). A block (including a
    // bare `{ … }` reached as a statement) has its own `statements` expanded and replaced when the
    // result differs; any other node is descended for blocks nested inside it. The block node's
    // identity is preserved either way.
    const mutateNestedStatementLists = (node: ts.Node): void => {
        // A `switch` case / default clause carries a statement list without being a `Block`.
        if (
            tsInstance.isBlock(node) || tsInstance.isModuleBlock(node) ||
            tsInstance.isCaseClause(node) || tsInstance.isDefaultClause(node)
        ) {
            const statements = expandStatementList(node.statements)

            if (statements !== node.statements) {
                const updated = tsInstance.factory.createNodeArray(statements)

                tsInstance.setTextRange(updated, node.statements)
                ;(node as { statements: ts.NodeArray<ts.Statement> }).statements = updated
            }

            return
        }

        tsInstance.forEachChild(node, (child) => {
            mutateNestedStatementLists(child)
        })
    }

    // `nullTransformationContext` is a real runtime export (a no-op lexical-environment context
    // that `visitEachChild` needs for function-like nodes) but is absent from the public typings.
    const nullTransformationContext = (tsInstance as unknown as {
        nullTransformationContext : ts.TransformationContext
    }).nullTransformationContext

    pushMixinNamespaceMergeDiagnostics(tsInstance, sourceFile, facts, context, sourceFile.statements)

    // A mixin / consumer declared inside a function body or block expands too: walk into nested
    // statement lists and splice the generated siblings into the CONTAINING block (never module
    // scope). No-op-safe — a file with no nested class keeps the original flat, top-level pass.
    const expandedStatements = facts.hasNestedClasses
        ? [ ...expandStatementList(sourceFile.statements) ]
        : sourceFile.statements.flatMap((statement) => expandClassStatement(statement, sourceFile.statements))

    if (!expandedAnything) {
        return sourceFile
    }

    // Which import-relevant names (helper candidates + decorator bindings) the output
    // actually references (excluding import declarations themselves). Used to prune imports
    // down to what is really used, so the transformed file never carries an unused import
    // (a `noUnusedLocals` / TS6133 error otherwise).
    const referencedNames = collectReferencedIdentifierNames(
        tsInstance,
        expandedStatements,
        referencedNameQueries(resolvedOptions, facts)
    )

    const withGeneratedImports = needsGeneratedImports
        ? insertGeneratedImports(tsInstance, expandedStatements, context, resolvedOptions, referencedNames)
        : expandedStatements

    return tsInstance.factory.updateSourceFile(
        sourceFile,
        pruneConsumedDecoratorImports(tsInstance, withGeneratedImports, facts, resolvedOptions, referencedNames)
    )
}

// A native diagnostic for an anonymous `@mixin` / anonymous mixin consumer, spanned on the class
// keyword of the (nameless) declaration so the squiggle lands on the class itself.
// A `@mixin` or a mixin consumer written as a class EXPRESSION (`const C = class implements M {}`)
// has no stable top-level (or block) statement slot for the generated siblings, so it is not
// expanded — and would otherwise fail with only a bare TS2420. Flag it with a clean native
// diagnostic instead. The class expressions come pre-collected (in document order) by the
// facts pass, so this never walks the file itself.
function pushAnonymousClassExpressionDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    facts: SourceFileFacts,
    context: FileMixinContext,
    imports: MixinDecoratorImports,
    options: TransformOptions
): void {
    for (const node of facts.classExpressions) {
        if (node.pos < 0 || node.end < 0) {
            continue
        }

        if (hasMixinDecorator(tsInstance, node, imports, options)) {
            context.nativeDiagnostics.push(anonymousClassNativeDiagnostic(
                tsInstance,
                sourceFile,
                node,
                mixinDiagnosticCode.AnonymousDefaultMixin,
                "Invalid mixin class declaration. A `@mixin` must be a named class declaration, not a class " +
                    "expression. Write `class MyMixin { … }` so the transformer can generate stable interface, " +
                    "factory, registry, and declaration names."
            ))
        } else if (implementsTypes(tsInstance, node as unknown as ts.ClassDeclaration).some(
            (heritageType) =>
                resolveLocalMixinHeritageRef(tsInstance, heritageType, context) !== undefined
        )) {
            context.nativeDiagnostics.push(anonymousClassNativeDiagnostic(
                tsInstance,
                sourceFile,
                node,
                mixinDiagnosticCode.AnonymousMixinConsumer,
                "Invalid mixin consumer declaration. A mixin consumer must be a named class declaration, not a " +
                    "class expression. Write `class Consumer implements Mixin { … }` so the transformer can " +
                    "generate stable intermediate base, diagnostic, and declaration names."
            ))
        }
    }
}

function anonymousClassNativeDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration | ts.ClassExpression,
    code: number,
    messageText: string
): NativeMixinDiagnostic {
    const keyword = declaration.getChildren(sourceFile)
        .find((child) => child.kind === tsInstance.SyntaxKind.ClassKeyword) ?? declaration

    return nativeDiagnosticOn(tsInstance, sourceFile, keyword, code, messageText)
}

// Whether the transform would produce a changed file. Cheap (a text guard, then
// cached source-file facts), so the compiler host can decide before the layered/host
// AST shape comparison and the source-view clone whether a file is worth touching.
export function transformAppliesToSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions,
    crossFile: CrossFileContext | undefined
): boolean {
    if (crossFile === undefined && !sourceFile.text.includes(options.packageName)) {
        return false
    }

    return shouldTransformSourceFile(
        tsInstance,
        sourceFile,
        getSourceFileFacts(tsInstance, sourceFile, options),
        options,
        crossFile
    )
}

function shouldTransformSourceFile(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    facts: SourceFileFacts,
    options: TransformOptions,
    crossFile: CrossFileContext | undefined
): boolean {
    // Nested classes live only in `classesByDeclaration`, not `classes`; a file whose only
    // mixin / consumer is nested must still transform, so the gate scans the full set when any
    // nested class exists (otherwise the cheaper top-level `classes` array, unchanged behaviour).
    const candidateClasses               = facts.hasNestedClasses
        ? [ ...facts.classesByDeclaration.values() ]
        : facts.classes
    const hasMixinDecoratorImports       = facts.mixinDecoratorImports.identifiers.size > 0 ||
        facts.mixinDecoratorImports.namespaces.size > 0
    const hasMixinDeclaration            = hasMixinDecoratorImports &&
        candidateClasses.some((classFacts) => classFacts.hasMixinDecorator)
    const hasPotentialConsumer           = candidateClasses.some((classFacts) => {
        return classFacts.implementsIdentifierNames.length > 0 ||
            classFacts.implementsQualifiedNames.length > 0
    }) && (hasMixinDecoratorImports || crossFile !== undefined)
    const hasPotentialConstructionConfig = candidateClasses.some((classFacts) => classFacts.extendsType !== undefined) &&
        (
            importsPackageBase(tsInstance, facts, options) ||
            extendsCrossFileConstructionBase(tsInstance, sourceFile, facts, crossFile)
        )
    // A file with no mixin declaration / consumer of its own can still hold a manual
    // `.mix` application of an IMPORTED program mixin — admit it so the TS990012 ban scan
    // (`pushManualMixinApplicationDiagnostics`) sees it. Text-gated with the same cheap
    // prefilter the scan itself uses; nothing in such a file expands, so it passes through.
    const hasPotentialManualMixApplication = crossFile !== undefined && sourceFile.text.includes(".mix")

    return hasMixinDeclaration || hasPotentialConsumer || hasPotentialConstructionConfig ||
        hasPotentialManualMixApplication
}

// Whether any class in the file extends an imported class that the cross-file
// registry knows to be a construction base. Lets the gate keep transforming files
// that derive from a Base descendant in another module without importing `Base`
// themselves, while still skipping ordinary `extends` of unrelated classes.
function extendsCrossFileConstructionBase(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined
): boolean {
    if (crossFile === undefined || crossFile.constructionBases.size === 0) {
        return false
    }

    // Identifier bases by name; QUALIFIED bases by their dotted text (`lib.Widget`) —
    // `resolveCrossFileConstructionBase` follows a dotted name through its
    // namespace-import binding.
    const extendsNames = facts.classes.flatMap((classFacts) => {
        const expression = classFacts.extendsType?.expression

        if (expression === undefined) {
            return []
        }

        if (tsInstance.isIdentifier(expression)) {
            return [ expression.text ]
        }

        const dottedName = dottedExpressionText(tsInstance, expression)

        return dottedName === undefined ? [] : [ dottedName ]
    })

    if (extendsNames.length === 0) {
        return false
    }

    const baseImportMap = buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName, facts)

    return extendsNames.some((name) => {
        return resolveCrossFileConstructionBase(name, crossFile, baseImportMap)?.isBaseDescendant === true
    })
}
