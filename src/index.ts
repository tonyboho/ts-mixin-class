import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"
import { expandConsumerClass } from "./consumer-expand.js"
import { brandedConstructionBaseHeritage } from "./consumer-base-heritage.js"
import { fillMissedInitializersClass } from "./construction-initializers.js"
import {
    createConstructionMembers,
    importsPackageBase,
    isConstructionBaseOptIn,
    positionConstructionConfigAlias,
    resolveCrossFileConstructionBase
} from "./construction-config.js"
import { buildFileMixinContext, buildImportedNameMap } from "./context.js"
import { attachDiagnosticRemap, wrapProgramDiagnostics } from "./emit-diagnostic-remap.js"
import { effectiveUseDefineForClassFields, resolveTransformOptions, resolveUsePrintedSourceFile } from "./transform-options.js"
import { appendGeneratedConfigAliasesAsRealText } from "./source-view-config-alias.js"
import {
    pushMixinMemberKindOverrideDiagnostics,
    pushMixinNamespaceMergeDiagnostics,
    pushMixinUsedBeforeDeclarationDiagnostics,
    pushPartialAccessorOverrideDiagnostics
} from "./mixin-override-diagnostics.js"
import { expandMixinClass } from "./mixin-expand.js"
import { pushManualMixinApplicationDiagnostics } from "./mixin-apply-type.js"
import { localMixinHeritageTypesFromFacts, resolveLocalMixinHeritageRef } from "./mixin-refs.js"
import { dottedExpressionText } from "./expand-util.js"
import { hasMixinDecorator } from "./decorators.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import {
    type ImportMap,
    nativeDiagnosticOn,
    anyConstructorName,
    applyLegacyClassDecoratorsName,
    applyLegacyClassDecoratorsLocalName,
    classStaticsName,
    defaultTransformOptions,
    implementsTypes,
    defineMixinClassName,
    defineMixinClassLocalName,
    metadataBaseImportName,
    metadataBaseLocalName,
    mixinApplicationName,
    mixinChainName,
    mixinChainLocalName,
    mixinChainLinearizedName,
    mixinChainLinearizedLocalName,
    constructionMixinClassValueName,
    mixinClassValueName,
    mixinDiagnosticCode,
    mixinFactoryName,
    runtimeMixinClassName,
    shouldSkipFileName,
    staticConflictKeysName,
    type CrossFileContext,
    type FileMixinContext,
    type MixinClassTransformerConfig,
    type MixinDecoratorImports,
    type NativeMixinDiagnostic,
    type TransformOptions
} from "./model.js"
import { buildConstructionBaseRegistry, buildMixinRegistry, hasRuntimeModuleForDeclaration } from "./registry.js"
import {
    cloneLayeredSourceFileForTransform,
    alignGeneratedNavigableNodesWithParseTree,
    cloneSourceFileForTransform,
    generatedTextRange,
    hasDifferentAstShape,
    preserveSourceFileVersion,
    preserveTextRange,
    preserveTopLevelStatementRanges,
    printSourceFileWithMappings,
    scriptKindFromFileName,
    setParentRecursivePreservingVersion,
    sourceFileOptionsPreservingFormat
} from "./util.js"
import type { TypeScript } from "./util.js"

export * from "./base.js"
export * from "./runtime.js"
export type {
    CrossFileContext,
    MixinClassTransformerConfig,
    MixinClassTransformerMode,
    MixinRegistry,
    RegisteredMixin,
    StaticCollisionCheckMode
} from "./model.js"
export { hasMixinDecorator } from "./decorators.js"
export { buildMixinRegistry } from "./registry.js"
export { printSourceFile } from "./util.js"

// ---------------------------------------------------------------------------
// ts-patch ProgramTransformer

const preserveSourceCache = new WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>()


export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: MixinClassTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const compilerOptions           = program.getCompilerOptions()
    const compilerHost              = host ?? tsInstance.createCompilerHost(compilerOptions)
    const options                   = resolveTransformOptions(
        config,
        effectiveUseDefineForClassFields(tsInstance, compilerOptions),
        compilerOptions.experimentalDecorators === true,
        compilerOptions.isolatedDeclarations === true
    )
    const resolvedModuleFileNames   = new Map<string, string | undefined>()
    const runtimeModuleAvailability = new Map<string, boolean>()

    const resolveModuleFileName = (specifier: string, containingFile: string): string | undefined => {
        const cacheKey = `${containingFile}\0${specifier}`

        if (resolvedModuleFileNames.has(cacheKey)) {
            return resolvedModuleFileNames.get(cacheKey)
        }

        const resolvedFileName = tsInstance.resolveModuleName(specifier, containingFile, compilerOptions, compilerHost)
            .resolvedModule?.resolvedFileName

        resolvedModuleFileNames.set(cacheKey, resolvedFileName)

        return resolvedFileName
    }
    const canImportRuntimeValue = (resolvedFileName: string): boolean => {
        const cached = runtimeModuleAvailability.get(resolvedFileName)

        if (cached !== undefined) {
            return cached
        }

        const available = hasRuntimeModuleForDeclaration(tsInstance, compilerHost, resolvedFileName)

        runtimeModuleAvailability.set(resolvedFileName, available)

        return available
    }

    const registry          = buildMixinRegistry(tsInstance, program, options, resolveModuleFileName)
    const constructionBases = buildConstructionBaseRegistry(tsInstance, program, options, resolveModuleFileName, registry)
    // Per-program sink the transform pushes native diagnostics into and the diagnostic wrap
    // drains. Shared by reference with `crossFile` (where the transform reaches it) below.
    const nativeDiagnostics: NativeMixinDiagnostic[] = []
    const crossFile                                  = registry.size === 0 && constructionBases.size === 0
        ? undefined
        : {
            registry,
            constructionBases,
            cacheKey           : registryCacheKey(registry, constructionBases),
            resolveModuleFileName,
            canImportRuntimeValue,
            linearizationCache : new Map<string, string[]>()
        }
    const nextHost                                   = createMixinClassCompilerHost(tsInstance, compilerHost, compilerOptions, config, crossFile, program, nativeDiagnostics)

    return wrapProgramDiagnostics(tsInstance, tsInstance.createProgram(
        program.getRootFileNames(),
        compilerOptions,
        nextHost,
        undefined
    ), program, nativeDiagnostics, crossFile, options, nextHost)
}

export function createMixinClassCompilerHost(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    compilerOptions: ts.CompilerOptions,
    config: MixinClassTransformerConfig,
    crossFile?: CrossFileContext,
    baseProgram?: ts.Program,
    nativeDiagnostics: NativeMixinDiagnostic[] = []
): ts.CompilerHost {
    const options              = resolveTransformOptions(
        config,
        effectiveUseDefineForClassFields(tsInstance, compilerOptions),
        compilerOptions.experimentalDecorators === true,
        compilerOptions.isolatedDeclarations === true
    )
    const sourceCache          = new WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>()
    const usePrintedSourceFile = resolveUsePrintedSourceFile(config, compilerOptions)

    return {
        ...compilerHost,

        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const layeredSourceFile = baseProgram?.getSourceFile(fileName)
            const preserveCacheKey  = usePrintedSourceFile
                ? undefined
                : preserveSourceCacheKey(options, crossFile, languageVersionOrOptions)

            if (preserveCacheKey !== undefined && layeredSourceFile !== undefined) {
                const cached = preserveSourceCache.get(layeredSourceFile)?.get(preserveCacheKey)

                if (cached !== undefined) {
                    return cached
                }
            }

            const cachePreserveSourceFile = (result: ts.SourceFile): ts.SourceFile => {
                if (preserveCacheKey !== undefined && layeredSourceFile !== undefined) {
                    setCachedSourceFile(preserveSourceCache, layeredSourceFile, preserveCacheKey, result)
                }

                return result
            }

            const hostSourceFile = compilerHost.getSourceFile(
                fileName,
                languageVersionOrOptions,
                onError,
                usePrintedSourceFile ? shouldCreateNewSourceFile : true
            )

            // Skipped files (declaration files, package-internal files) are never
            // transformed, and the skip test is fileName-based, so it is identical
            // for the layered and host candidates. Bail out before the structural
            // comparison so we don't walk both ASTs of every lib / node_modules
            // .d.ts on a cold program build.
            const skipCandidate = hostSourceFile ?? layeredSourceFile

            if (skipCandidate === undefined) {
                return skipCandidate
            }

            if (shouldSkipSourceFile(skipCandidate)) {
                return cachePreserveSourceFile(skipCandidate)
            }

            // A file the transform would leave unchanged never needs the
            // layered/host shape comparison or the source-view clone. Decide that
            // up front from a text guard plus cached facts, and hand the file back
            // as-is, instead of walking both ASTs (and cloning) per cold build / edit.
            if (!transformAppliesToSourceFile(tsInstance, skipCandidate, options, crossFile)) {
                return cachePreserveSourceFile(skipCandidate)
            }

            const useLayeredSourceFile = layeredSourceFile !== undefined &&
                (
                    hostSourceFile === undefined ||
                    layeredSourceFile !== hostSourceFile && hasDifferentAstShape(tsInstance, layeredSourceFile, hostSourceFile)
                )
            const sourceFile           = useLayeredSourceFile ? layeredSourceFile : hostSourceFile

            if (sourceFile === undefined) {
                return sourceFile
            }

            if (usePrintedSourceFile) {
                const cacheKey = String(shouldCreateNewSourceFile)
                const cached   = sourceCache.get(sourceFile)?.get(cacheKey)

                if (cached !== undefined) {
                    return cached
                }

                const transformedSourceFile = transformSourceFile(tsInstance, sourceFile, options, crossFile, nativeDiagnostics)

                if (transformedSourceFile === sourceFile) {
                    setCachedSourceFile(sourceCache, sourceFile, cacheKey, sourceFile)
                    return sourceFile
                }

                const printed           = printSourceFileWithMappings(tsInstance, transformedSourceFile)
                const printedSourceFile = tsInstance.createSourceFile(
                    fileName,
                    printed.text,
                    sourceFileOptionsPreservingFormat(languageVersionOrOptions, sourceFile),
                    true,
                    scriptKindFromFileName(tsInstance, fileName)
                )

                // The reprinted file replaces the host's one inside the program, so it must
                // carry the host file's `version` — the builder pipeline (`tsc --watch`
                // with emit) asserts on it.
                preserveSourceFileVersion(printedSourceFile, sourceFile)

                // Remember how to translate diagnostics computed over this reprinted text
                // back to the real source, so the program wrapper can fix emit-path line
                // numbers without touching the (runtime-correct) reprinted tree.
                attachDiagnosticRemap(printedSourceFile, sourceFile, printed.mappings)

                setCachedSourceFile(sourceCache, sourceFile, cacheKey, printedSourceFile)

                return printedSourceFile
            }

            const transformSourceFileInput = useLayeredSourceFile
                ? cloneLayeredSourceFileForTransform(tsInstance, sourceFile)
                : cloneSourceFileForTransform(tsInstance, sourceFile, languageVersionOrOptions)
            const transformedSourceFile    = transformSourceFile(tsInstance, transformSourceFileInput, {
                ...options,
                sourceView : true
            }, crossFile, nativeDiagnostics)

            if (transformedSourceFile === transformSourceFileInput) {
                return cachePreserveSourceFile(sourceFile)
            }

            // [PROTOTYPE] Append each generated `<Name>Config` alias as REAL text past the
            // original end so the checker reads its real name (diagnostics, error hover AND
            // quickinfo, incl. generics). The phantom appended region is past the document; a
            // paired language-service plugin filters navigation results that land there.
            const withAliasText = appendGeneratedConfigAliasesAsRealText(
                tsInstance, transformedSourceFile, languageVersionOrOptions, fileName
            )

            preserveTopLevelStatementRanges(tsInstance, withAliasText)

            const reparented = setParentRecursivePreservingVersion(tsInstance, withAliasText, sourceFile)

            return cachePreserveSourceFile(alignGeneratedNavigableNodesWithParseTree(tsInstance, reparented))
        }
    }
}


// ---------------------------------------------------------------------------
// Source file transformation

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
        tsInstance, sourceFile, mixinDecoratorImports, resolvedOptions, crossFile, facts, nativeDiagnostics
    )

    pushAnonymousClassExpressionDiagnostics(tsInstance, sourceFile, context, mixinDecoratorImports, resolvedOptions)
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

            return tsInstance.visitEachChild(inner, visit, nullTransformationContext)
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

    // Names actually referenced in the generated output (excluding import declarations
    // themselves). Used to prune imports down to what is really used, so the transformed
    // file never carries an unused import (a `noUnusedLocals` / TS6133 error otherwise).
    const referencedNames = collectReferencedIdentifierNames(tsInstance, expandedStatements)

    const withGeneratedImports = needsGeneratedImports
        ? insertGeneratedImports(tsInstance, expandedStatements, context, resolvedOptions, referencedNames)
        : expandedStatements

    return tsInstance.factory.updateSourceFile(
        sourceFile,
        pruneConsumedDecoratorImports(tsInstance, withGeneratedImports, facts, resolvedOptions, referencedNames)
    )
}

// Every identifier referenced in `statements`, skipping import declarations (an imported
// name is a binding, not a use). A superset is harmless: it only ever keeps an import we
// could have pruned, never drops one that is needed.
function collectReferencedIdentifierNames(
    tsInstance: TypeScript,
    statements: readonly ts.Statement[]
): Set<string> {
    const names = new Set<string>()

    const visit = (node: ts.Node): void => {
        if (tsInstance.isImportDeclaration(node)) {
            return
        }

        if (tsInstance.isIdentifier(node)) {
            names.add(node.text)
        }

        tsInstance.forEachChild(node, visit)
    }

    for (const statement of statements) {
        visit(statement)
    }

    return names
}

// After `@mixin()` decorators are consumed (the class is replaced by the generated factory),
// the user's `mixin` import is no longer referenced; leaving it triggers `noUnusedLocals`
// (TS6133). Drop exactly the decorator specifier(s) we consumed, and only when the bound name
// is unreferenced everywhere else (so a `mixin` the user also uses directly survives). Limited
// to the EMIT path: in source view the original class (and its decorator) is position-preserved,
// and rewriting the user's real import there risks stranding nodes.
function pruneConsumedDecoratorImports(
    tsInstance: TypeScript,
    statements: ts.Statement[],
    facts: SourceFileFacts,
    options: TransformOptions,
    referenced: Set<string>
): ts.Statement[] {
    const { identifiers, namespaces } = facts.mixinDecoratorImports

    if (options.sourceView || (identifiers.size === 0 && namespaces.size === 0)) {
        return statements
    }

    const factory = tsInstance.factory

    return statements.flatMap((statement): ts.Statement[] => {
        if (!tsInstance.isImportDeclaration(statement) ||
            !tsInstance.isStringLiteral(statement.moduleSpecifier) ||
            statement.moduleSpecifier.text !== options.packageName) {
            return [ statement ]
        }

        const clause = statement.importClause

        if (clause === undefined || clause.namedBindings === undefined) {
            return [ statement ]
        }

        // `import * as ns`: drop the whole import when the namespace is a consumed decorator
        // namespace that is otherwise unreferenced (and there is no default binding to keep).
        if (tsInstance.isNamespaceImport(clause.namedBindings)) {
            const name = clause.namedBindings.name.text

            return namespaces.has(name) && !referenced.has(name) && clause.name === undefined
                ? []
                : [ statement ]
        }

        if (!tsInstance.isNamedImports(clause.namedBindings)) {
            return [ statement ]
        }

        const kept = clause.namedBindings.elements.filter((element) =>
            !(identifiers.has(element.name.text) && !referenced.has(element.name.text)))

        if (kept.length === clause.namedBindings.elements.length) {
            return [ statement ]
        }

        if (kept.length === 0 && clause.name === undefined) {
            return []
        }

        return [ factory.createImportDeclaration(
            statement.modifiers,
            factory.createImportClause(clause.isTypeOnly, clause.name, factory.createNamedImports(kept)),
            statement.moduleSpecifier
        ) ]
    })
}

function expandConstructionBaseClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    options: TransformOptions,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined
): ts.Statement[] {
    const factory      = tsInstance.factory
    const extendsType  = declaration.heritageClauses?.find((clause) => {
        return clause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })?.types[0]
    const rewritten    = fillMissedInitializersClass(tsInstance, declaration, options)
    const construction = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        undefined,
        [],
        options,
        // Anchor the generated `static new` to the END of the class body in BOTH modes.
        // `declaration.pos` (used for emit before) includes leading trivia, so it points
        // at the previous sibling's `}`; a diagnostic on the generated member (e.g. a
        // perturbed config key) then remaps onto the *previous* class, diverging from the
        // source-view position. `members.end` keeps it inside this class (parity).
        generatedTextRange(sourceFile, declaration.members.end),
        crossFile,
        baseImportMap
    )

    if (construction.members.length === 0) {
        return [ rewritten ]
    }

    const updatedClass         = factory.updateClassDeclaration(
        rewritten,
        rewritten.modifiers,
        rewritten.name,
        rewritten.typeParameters,
        brandedConstructionHeritageClauses(tsInstance, declaration, rewritten, extendsType, options),
        preserveTextRange(
            tsInstance,
            factory.createNodeArray([ ...rewritten.members, ...construction.members ]),
            rewritten.members
        )
    )
    const configAliasStatement = construction.configAlias === undefined
        ? []
        : [ positionConstructionConfigAlias(
            tsInstance,
            construction.configAlias,
            // Anchor just past the closing brace, OUTSIDE the class body, so the alias
            // overlaps no sibling; both modes share that real position (stress parity).
            generatedTextRange(sourceFile, declaration.end),
            declaration
        ) ]

    return [ updatedClass, ...configAliasStatement ]
}

// Replaces the construction base class's `extends Base` clause with a branded cast so
// `new Model(...)` is a type error (construction goes through the generated static
// `new`). In source view this is gated to a simple identifier base (a qualified
// `ns.Base` keeps its literal, navigable heritage and is still guarded by the emitted
// `tsc` build). Non-extends clauses (`implements`) and the original positions are kept.
function brandedConstructionHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    rewritten: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    options: TransformOptions
): ts.NodeArray<ts.HeritageClause> | undefined {
    const heritageClauses = rewritten.heritageClauses

    if (heritageClauses === undefined ||
        extendsType === undefined ||
        declaration.name === undefined ||
        // A class with its own constructor opts into manual construction; branding the
        // base would only break its `super(...)` call (see consumer-expand's gate).
        declaration.members.some((member) => tsInstance.isConstructorDeclaration(member)) ||
        (options.sourceView && !tsInstance.isIdentifier(extendsType.expression))
    ) {
        return heritageClauses
    }

    const brandedClause = brandedConstructionBaseHeritage(
        tsInstance,
        extendsType,
        declaration.name.text,
        options
    )

    return preserveTextRange(
        tsInstance,
        tsInstance.factory.createNodeArray(heritageClauses.map((clause) => {
            return clause.token === tsInstance.SyntaxKind.ExtendsKeyword ? brandedClause : clause
        })),
        heritageClauses
    )
}

// A native diagnostic for an anonymous `@mixin` / anonymous mixin consumer, spanned on the class
// keyword of the (nameless) declaration so the squiggle lands on the class itself.
// A `@mixin` or a mixin consumer written as a class EXPRESSION (`const C = class implements M {}`)
// has no stable top-level (or block) statement slot for the generated siblings, so it is not
// expanded — and would otherwise fail with only a bare TS2420. Flag it with a clean native
// diagnostic instead. Walks the whole file (cheap; only the few class expressions are inspected),
// since a class expression lives in expression position, never a statement list.
function pushAnonymousClassExpressionDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    context: FileMixinContext,
    imports: MixinDecoratorImports,
    options: TransformOptions
): void {
    const visit = (node: ts.Node): void => {
        if (tsInstance.isClassExpression(node) && node.pos >= 0 && node.end >= 0) {
            if (hasMixinDecorator(tsInstance, node, imports, options)) {
                context.nativeDiagnostics.push(anonymousClassNativeDiagnostic(
                    tsInstance, sourceFile, node, mixinDiagnosticCode.AnonymousDefaultMixin,
                    "Invalid mixin class declaration. A `@mixin` must be a named class declaration, not a class " +
                        "expression. Write `class MyMixin { … }` so the transformer can generate stable interface, " +
                        "factory, registry, and declaration names."
                ))
            } else if (implementsTypes(tsInstance, node as unknown as ts.ClassDeclaration).some((heritageType) =>
                resolveLocalMixinHeritageRef(tsInstance, heritageType, context) !== undefined
            )) {
                context.nativeDiagnostics.push(anonymousClassNativeDiagnostic(
                    tsInstance, sourceFile, node, mixinDiagnosticCode.AnonymousMixinConsumer,
                    "Invalid mixin consumer declaration. A mixin consumer must be a named class declaration, not a " +
                        "class expression. Write `class Consumer implements Mixin { … }` so the transformer can " +
                        "generate stable intermediate base, diagnostic, and declaration names."
                ))
            }
        }

        tsInstance.forEachChild(node, visit)
    }

    tsInstance.forEachChild(sourceFile, visit)
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

// Generated imports (type helpers + mixin factories from other modules) are
// inserted after the last original import.
function insertGeneratedImports(
    tsInstance: TypeScript,
    statements: ts.Statement[],
    context: FileMixinContext,
    options: TransformOptions,
    referenced: Set<string>
): ts.Statement[] {
    const helperImport = createHelperTypeImport(tsInstance, options, referenced)

    const generatedImports: ts.ImportDeclaration[] = helperImport === undefined ? [] : [ helperImport ]

    const bySpecifier = new Map<string, NamedImportElement[]>()

    for (const factoryImport of context.usedFactoryImports.values()) {
        const elements = bySpecifier.get(factoryImport.specifier) ?? []

        elements.push(factoryImport)
        bySpecifier.set(factoryImport.specifier, elements)
    }

    for (const [ specifier, elements ] of bySpecifier) {
        generatedImports.push(createNamedImportDeclaration(tsInstance, specifier, elements))
    }

    let lastImportIndex = -1

    for (let index = 0; index < statements.length; index++) {
        if (tsInstance.isImportDeclaration(statements[index])) {
            lastImportIndex = index
        }
    }

    return [
        ...statements.slice(0, lastImportIndex + 1),
        ...generatedImports,
        ...statements.slice(lastImportIndex + 1)
    ]
}

// ---------------------------------------------------------------------------
// Helper builders

type NamedImportElement = {
    typeOnly?    : boolean,
    importedName : string,
    localName    : string
}

// One named-import declaration (`import { a, type b as c } from "specifier"`). Shared by
// the helper-type import and the per-specifier mixin-factory imports; `typeOnly` defaults
// to false, and an alias specifier is emitted only when imported and local names differ.
function createNamedImportDeclaration(
    tsInstance: TypeScript,
    specifier: string,
    elements: readonly NamedImportElement[]
): ts.ImportDeclaration {
    const factory = tsInstance.factory

    return factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
            false,
            undefined,
            factory.createNamedImports(elements.map((element) => factory.createImportSpecifier(
                element.typeOnly ?? false,
                element.importedName === element.localName ? undefined : factory.createIdentifier(element.importedName),
                factory.createIdentifier(element.localName)
            )))
        ),
        factory.createStringLiteral(specifier)
    )
}

function createHelperTypeImport(
    tsInstance: TypeScript,
    options: TransformOptions,
    referenced: Set<string>
): ts.ImportDeclaration | undefined {
    // Every helper the transform CAN generate, with its local name. The fixed superset is
    // pruned to only the helpers actually referenced in this file's generated output, so a
    // file never imports a helper it does not use (a `noUnusedLocals` / TS6133 error). When
    // nothing is referenced (no helper import needed), the whole declaration is dropped.
    const candidates: NamedImportElement[] = [
        { typeOnly: false, importedName: defineMixinClassName,     localName: defineMixinClassLocalName },
        { typeOnly: false, importedName: applyLegacyClassDecoratorsName, localName: applyLegacyClassDecoratorsLocalName },
        { typeOnly: false, importedName: mixinChainName,           localName: mixinChainLocalName },
        { typeOnly: false, importedName: mixinChainLinearizedName, localName: mixinChainLinearizedLocalName },
        { typeOnly: true,  importedName: anyConstructorName,   localName: anyConstructorName },
        { typeOnly: true,  importedName: classStaticsName,     localName: classStaticsName },
        { typeOnly: true,  importedName: mixinApplicationName, localName: mixinApplicationName },
        { typeOnly: true,  importedName: mixinFactoryName,     localName: mixinFactoryName },
        ...(options.staticCollisionCheck === false
            ? []
            : [ {
                typeOnly     : true,
                importedName : staticConflictKeysName(options.staticCollisionCheck),
                localName    : staticConflictKeysName(options.staticCollisionCheck)
            } ]),
        { typeOnly: true, importedName: metadataBaseImportName,        localName: metadataBaseLocalName },
        { typeOnly: true, importedName: runtimeMixinClassName,         localName: runtimeMixinClassName },
        { typeOnly: true, importedName: mixinClassValueName,           localName: mixinClassValueName },
        { typeOnly: true, importedName: constructionMixinClassValueName, localName: constructionMixinClassValueName }
    ]

    const used = candidates.filter((candidate) => referenced.has(candidate.localName))

    if (used.length === 0) {
        return undefined
    }

    return createNamedImportDeclaration(tsInstance, options.packageName, used)
}

// Whether the transform would produce a changed file. Cheap (a text guard, then
// cached source-file facts), so the compiler host can decide before the layered/host
// AST shape comparison and the source-view clone whether a file is worth touching.
function transformAppliesToSourceFile(
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

function shouldSkipSourceFile(sourceFile: ts.SourceFile): boolean {
    return sourceFile.isDeclarationFile || shouldSkipFileName(sourceFile.fileName)
}

function setCachedSourceFile(
    sourceCache: WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>,
    sourceFile: ts.SourceFile,
    cacheKey: string,
    cachedSourceFile: ts.SourceFile
): void {
    const cachedByOptions = sourceCache.get(sourceFile) ?? new Map<string, ts.SourceFile>()

    cachedByOptions.set(cacheKey, cachedSourceFile)
    sourceCache.set(sourceFile, cachedByOptions)
}

function preserveSourceCacheKey(
    options: TransformOptions,
    crossFile: CrossFileContext | undefined,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions
): string {
    const languageVersionKey = typeof languageVersionOrOptions === "object"
        ? [
            languageVersionOrOptions.languageVersion,
            languageVersionOrOptions.impliedNodeFormat ?? "",
            languageVersionOrOptions.jsDocParsingMode ?? ""
        ].join(":")
        : String(languageVersionOrOptions)

    return [
        options.packageName,
        options.decoratorName,
        options.staticCollisionCheck,
        options.fillMissedInitializersWith,
        String(options.verifyLinearization),
        String(options.disableLinearizationPlan),
        crossFile?.cacheKey ?? "",
        languageVersionKey
    ].join("|")
}

function registryCacheKey(
    registry: CrossFileContext["registry"],
    constructionBases: CrossFileContext["constructionBases"]
): string {
    const mixinKey            = [ ...registry.entries() ]
        .map(([ key, entry ]) => {
            return [
                key,
                entry.fileName,
                entry.name,
                String(entry.defaultExport),
                entry.requiredBaseName ?? "",
                entry.dependencies.join(","),
                entry.configProperties.map((property) => {
                    return `${property.name}:${String(property.optional)}`
                }).join(",")
            ].join(":")
        })
        .sort()
        .join("|")
    const constructionBaseKey = [ ...constructionBases.entries() ]
        .map(([ key, entry ]) => {
            return [
                key,
                entry.configProperties.map((property) => {
                    return `${property.name}:${String(property.optional)}`
                }).join(",")
            ].join(":")
        })
        .sort()
        .join("|")

    return `${mixinKey}\0${constructionBaseKey}`
}
