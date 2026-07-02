import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"
import { expandConsumerClass } from "./consumer-expand.js"
import { brandedConstructionBaseHeritage } from "./consumer-base-heritage.js"
import { fillMissedInitializersClass } from "./construction-initializers.js"
import {
    createConstructionMembers,
    generatedStaticNewMarker,
    importsPackageBase,
    isConstructionBaseOptIn,
    positionConstructionConfigAlias,
    resolveCrossFileConstructionBase
} from "./construction-config.js"
import { buildFileMixinContext, buildImportedNameMap } from "./context.js"
import { expandMixinClass } from "./mixin-expand.js"
import { localMixinHeritageTypesFromFacts } from "./mixin-refs.js"
import { hasMixinDecorator } from "./decorators.js"
import { getSourceFileFacts, type ClassFacts, type SourceFileFacts } from "./source-file-facts.js"
import {
    anyConstructorName,
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
    type FillMissedInitializersWith,
    type ImportedNameBinding,
    type MixinClassTransformerConfig,
    type MixinDecoratorImports,
    type NativeMixinDiagnostic,
    type StaticCollisionCheckMode,
    type TransformOptions
} from "./model.js"
import { buildConstructionBaseRegistry, buildMixinRegistry, hasRuntimeModuleForDeclaration } from "./registry.js"
import {
    cloneLayeredSourceFileForTransform,
    alignGeneratedNavigableNodesWithParseTree,
    hasModifier,
    cloneSourceFileForTransform,
    deepCloneNode,
    generatedTextRange,
    hasDifferentAstShape,
    preserveTextRange,
    preserveTopLevelStatementRanges,
    printSourceFileWithMappings,
    scriptKindFromFileName,
    setParentRecursivePreservingVersion,
    sourceFileOptionsPreservingFormat
} from "./util.js"
import type { PrintedSourceMapping, TypeScript } from "./util.js"

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

// ---------------------------------------------------------------------------
// Emit-path diagnostic remapping
//
// On the emit path the transform reprints the value-cast tree to text and reparses
// it (required: only that form emits correct runtime JS). Mixin expansion adds and
// removes lines, so diagnostics the checker computes over the reprinted text land on
// regenerated lines that do not exist on disk — `tsc` then reports errors at the
// wrong line (a deal-breaker for CI). We keep the reprinted tree for emit, but stash
// the printer's source map on each reprinted file and wrap the program's diagnostic
// getters to translate every diagnostic position back to the real source. The
// language-service / `--noEmit` path is position-preserving already and never reaches
// this code.

type DiagnosticRemap = {
    originalSourceFile : ts.SourceFile,
    mappings           : PrintedSourceMapping[],
    sortedMappings?    : PrintedSourceMapping[]
}

const diagnosticRemapKey = "__tsMixinClassDiagnosticRemap"

function attachDiagnosticRemap(
    printedSourceFile: ts.SourceFile,
    originalSourceFile: ts.SourceFile,
    mappings: PrintedSourceMapping[]
): void {
    ;(printedSourceFile as { [diagnosticRemapKey]?: DiagnosticRemap })[diagnosticRemapKey] = {
        originalSourceFile,
        mappings
    }
}

function diagnosticRemapOf(file: ts.SourceFile | undefined): DiagnosticRemap | undefined {
    if (file === undefined) {
        return undefined
    }

    return (file as { [diagnosticRemapKey]?: DiagnosticRemap })[diagnosticRemapKey]
}

function sortedMappingsOf(remap: DiagnosticRemap): PrintedSourceMapping[] {
    if (remap.sortedMappings !== undefined) {
        return remap.sortedMappings
    }

    remap.sortedMappings = [ ...remap.mappings ].sort((left, right) => {
        return left.generatedLine - right.generatedLine ||
            left.generatedCharacter - right.generatedCharacter
    })

    return remap.sortedMappings
}

// Index of the greatest source-map entry whose generated position is `<=` the queried
// one, by binary search; -1 when the query precedes every entry. The entry on the
// *same* generated line gives a column-accurate translation; when the queried line has
// no entry — a fully generated line, e.g. a transformer-emitted diagnostic anchored to
// synthetic code — the nearest preceding entry still recovers the correct source line.
function precedingMappingIndex(
    sortedMappings: PrintedSourceMapping[],
    generatedLine: number,
    generatedCharacter: number
): number {
    let low   = 0
    let high  = sortedMappings.length - 1
    let match = -1

    while (low <= high) {
        const mid     = (low + high) >> 1
        const mapping = sortedMappings[mid]
        const ordered = mapping.generatedLine < generatedLine ||
            mapping.generatedLine === generatedLine && mapping.generatedCharacter <= generatedCharacter

        if (ordered) {
            match = mid
            low   = mid + 1
        } else {
            high = mid - 1
        }
    }

    return match
}

// Translate an offset in the reprinted text to the matching offset in the original
// source, via the printer's source map. Returns undefined only when the file carries
// no usable mapping (nothing to anchor to).
function mapPrintedOffsetToSource(
    tsInstance: TypeScript,
    remap: DiagnosticRemap,
    printedSourceFile: ts.SourceFile,
    printedOffset: number
): number | undefined {
    const generated      = tsInstance.getLineAndCharacterOfPosition(printedSourceFile, printedOffset)
    const sortedMappings = sortedMappingsOf(remap)
    const matchIndex     = precedingMappingIndex(sortedMappings, generated.line, generated.character)

    if (matchIndex < 0) {
        return undefined
    }

    const match      = sortedMappings[matchIndex]
    const lineStarts = remap.originalSourceFile.getLineStarts()

    if (match.sourceLine >= lineStarts.length) {
        return undefined
    }

    const lineStart     = lineStarts[match.sourceLine]
    const nextLineStart = match.sourceLine + 1 < lineStarts.length
        ? lineStarts[match.sourceLine + 1]
        : remap.originalSourceFile.text.length

    // On the same generated line, advance from the matched entry's source column by the
    // generated-column delta — but a *generated* run (e.g. a long error-alias) can
    // collapse many printed columns onto one source column, so the next entry on the
    // same generated+source line caps how far the column may advance. Off the matched
    // generated line (preceding-line fallback) keep the entry's own source column.
    let sourceCharacter = match.sourceCharacter

    if (match.generatedLine === generated.line) {
        const next   = sortedMappings[matchIndex + 1]
        const capped = next !== undefined &&
            next.generatedLine === generated.line &&
            next.sourceLine === match.sourceLine
            ? next.sourceCharacter
            : Number.POSITIVE_INFINITY

        sourceCharacter = Math.min(match.sourceCharacter + (generated.character - match.generatedCharacter), capped)
    }

    const offset = lineStart + Math.max(0, sourceCharacter)

    // Never let an extrapolated column cross into the next source line.
    return nextLineStart > lineStart ? Math.min(offset, nextLineStart - 1) : offset
}

function remapDiagnostic<Diagnostic extends ts.Diagnostic | ts.DiagnosticRelatedInformation>(
    tsInstance: TypeScript,
    diagnostic: Diagnostic
): Diagnostic {
    const remap = diagnosticRemapOf(diagnostic.file)

    if (remap === undefined || diagnostic.file === undefined) {
        return diagnostic
    }

    const printedSourceFile = diagnostic.file
    const start             = diagnostic.start === undefined
        ? undefined
        : mapPrintedOffsetToSource(tsInstance, remap, printedSourceFile, diagnostic.start)

    // The position could not be mapped (generated-only line): keep the diagnostic as
    // is rather than pin it onto the original file at a wrong offset.
    if (diagnostic.start !== undefined && start === undefined) {
        return diagnostic
    }

    let length = diagnostic.length

    if (diagnostic.start !== undefined && diagnostic.length !== undefined && start !== undefined) {
        const end = mapPrintedOffsetToSource(tsInstance, remap, printedSourceFile, diagnostic.start + diagnostic.length)

        if (end !== undefined && end >= start) {
            length = end - start
        }
    }

    const relatedInformation = (diagnostic as ts.Diagnostic).relatedInformation?.map((related) => {
        return remapDiagnostic(tsInstance, related)
    })

    return {
        ...diagnostic,
        file               : remap.originalSourceFile,
        start,
        length,
        relatedInformation : relatedInformation ?? (diagnostic as ts.Diagnostic).relatedInformation
    }
}

function remapDiagnostics<Diagnostic extends ts.Diagnostic>(
    tsInstance: TypeScript,
    diagnostics: readonly Diagnostic[]
): Diagnostic[] {
    return diagnostics.map((diagnostic) => remapDiagnostic(tsInstance, diagnostic))
}

// Append the transformer-authored NATIVE diagnostics (scoped to `sourceFile`, or all when the
// whole program is requested) to the checker's diagnostics for the same scope. Each native
// diagnostic is positioned on the ORIGINAL on-disk source, so its `file` is resolved from the
// pre-transform program — correct for both the emit (reprinted) and source-view trees without
// going through the reprint remap. Built lazily and only when there is something to add.
function appendNativeDiagnostics(
    tsInstance: TypeScript,
    originalProgram: ts.Program,
    nativeDiagnostics: NativeMixinDiagnostic[],
    diagnostics: ts.Diagnostic[],
    sourceFile: ts.SourceFile | undefined
): ts.Diagnostic[] {
    if (nativeDiagnostics.length === 0) {
        return diagnostics
    }

    const scoped = sourceFile === undefined
        ? nativeDiagnostics
        : nativeDiagnostics.filter((native) => native.fileName === sourceFile.fileName)

    if (scoped.length === 0) {
        return diagnostics
    }

    const built = scoped.flatMap((native): ts.DiagnosticWithLocation[] => {
        const file = originalProgram.getSourceFile(native.fileName)

        if (file === undefined) {
            return []
        }

        return [ {
            category    : native.category,
            code        : native.code,
            file,
            start       : native.start,
            length      : native.length,
            messageText : native.messageText
        } ]
    })

    return [ ...diagnostics, ...built ]
}

// Wrap the diagnostic getters tsc reports through so emit-path positions point at the
// real source. `getSyntacticDiagnostics` (DiagnosticWithLocation) stays well-typed
// because the remap keeps a `file`. `emit` carries declaration-emit diagnostics.
function wrapProgramDiagnostics(
    tsInstance: TypeScript,
    program: ts.Program,
    originalProgram: ts.Program,
    nativeDiagnostics: NativeMixinDiagnostic[]
): ts.Program {
    const originalGetSyntactic   = program.getSyntacticDiagnostics.bind(program)
    const originalGetSemantic    = program.getSemanticDiagnostics.bind(program)
    const originalGetDeclaration = program.getDeclarationDiagnostics.bind(program)
    const originalEmit           = program.emit.bind(program)

    program.getSyntacticDiagnostics   = (sourceFile, cancellationToken) => {
        return remapDiagnostics(tsInstance, originalGetSyntactic(sourceFile, cancellationToken))
    }
    program.getSemanticDiagnostics    = (sourceFile, cancellationToken) => {
        // Author-time NATIVE diagnostics ride here alongside the (position-remapped) checker
        // diagnostics, so they reach both `tsc` and tsserver through the one seam.
        return appendNativeDiagnostics(
            tsInstance,
            originalProgram,
            nativeDiagnostics,
            remapDiagnostics(tsInstance, originalGetSemantic(sourceFile, cancellationToken)),
            sourceFile
        )
    }
    program.getDeclarationDiagnostics = (sourceFile, cancellationToken) => {
        return remapDiagnostics(tsInstance, originalGetDeclaration(sourceFile, cancellationToken))
    }
    program.emit                      = (targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers) => {
        // Strip the redundant generated `static new` factories from JS emit (they only
        // forward to the inherited `Base.new`). A `before` transformer runs after type
        // checking but only affects the JS pipeline — declaration emit keeps the typed
        // `static new`, so the public factory type survives in `.d.ts`. No-op for
        // declaration-only emit.
        const mergedTransformers: ts.CustomTransformers | undefined = emitOnlyDtsFiles === true
            ? customTransformers
            : {
                ...customTransformers,
                before : [
                    ...(customTransformers?.before ?? []),
                    stripGeneratedStaticNew(tsInstance)
                ]
            }
        const result                                                = originalEmit(targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, mergedTransformers)

        return {
            ...result,
            diagnostics : remapDiagnostics(tsInstance, result.diagnostics)
        }
    }

    return program
}

// A `before` emit transformer that drops the generated, runtime-redundant `static new`
// factory from JS output (it only forwards to the inherited `Base.new`). It hooks the method
// node directly: a `static new` whose body opens with the `void "$tmc$"` marker is removed
// (return `undefined`), and `visitEachChild` rebuilds the members array only for the class
// that actually carried it. Removing just the marked IMPLEMENTATION suffices — its sibling
// typed overload signature has no body and so emits nothing in JS, while declaration emit
// keeps it, preserving the public `static new(props: <Class>Config): <Class>` in `.d.ts`.
//
// The marker is a unique string the reprint bakes into the file text, so a single `indexOf`
// gate skips every file without a generated factory (the vast majority) with NO AST traversal.
function stripGeneratedStaticNew(tsInstance: TypeScript): ts.TransformerFactory<ts.SourceFile> {
    return (context) => {
        // The match is inlined (no per-node helper call): drop a `static new` whose body opens
        // with the `void "$tmc$"` marker statement; otherwise recurse.
        const visit = (node: ts.Node): ts.Node | undefined => {
            if (tsInstance.isMethodDeclaration(node) &&
                tsInstance.isIdentifier(node.name) &&
                node.name.text === "new" &&
                node.body !== undefined &&
                node.body.statements.length > 0
            ) {
                const first = node.body.statements[0]

                if (tsInstance.isExpressionStatement(first) &&
                    tsInstance.isVoidExpression(first.expression) &&
                    tsInstance.isStringLiteral(first.expression.expression) &&
                    first.expression.expression.text === generatedStaticNewMarker
                ) {
                    return undefined
                }
            }

            return tsInstance.visitEachChild(node, visit, context)
        }

        return (sourceFile) => {
            // Fast path: no generated factory anywhere in this file — skip AST traversal.
            if (sourceFile.text.indexOf(generatedStaticNewMarker) === -1) {
                return sourceFile
            }

            return tsInstance.visitNode(sourceFile, visit) as ts.SourceFile
        }
    }
}

// The compilation's EFFECTIVE `useDefineForClassFields`: the explicit option, or TypeScript's
// own default of `target >= ES2022`.
function effectiveUseDefineForClassFields(tsInstance: TypeScript, compilerOptions: ts.CompilerOptions): boolean {
    return compilerOptions.useDefineForClassFields ??
        (compilerOptions.target ?? tsInstance.ScriptTarget.ES3) >= tsInstance.ScriptTarget.ES2022
}

function resolveTransformOptions(
    config: MixinClassTransformerConfig,
    useDefineForClassFields?: boolean
): TransformOptions {
    return {
        packageName                : config.packageName ?? defaultTransformOptions.packageName,
        decoratorName              : config.decoratorName ?? defaultTransformOptions.decoratorName,
        sourceView                 : false,
        useDefineForClassFields    : useDefineForClassFields ?? defaultTransformOptions.useDefineForClassFields,
        staticCollisionCheck       : normalizeStaticCollisionCheck(config.staticCollisionCheck),
        fillMissedInitializersWith : normalizeFillMissedInitializers(config.fillMissedInitializersWith),
        // Read at build time (the transformer runs under tsc in Node) and baked into the emit
        // as a trailing mode argument, so the shipped runtime never reads the environment.
        // Verification is on by default (set TS_MIXIN_VERIFY_LINEARIZATION=0 to drop it in
        // production); the precompute is on unless TS_MIXIN_DISABLE_LINEARIZATION_PLAN=1.
        verifyLinearization        : envFlag("TS_MIXIN_VERIFY_LINEARIZATION") !== "0" &&
            envFlag("TS_MIXIN_VERIFY_LINEARIZATION") !== "false",
        disableLinearizationPlan : envFlag("TS_MIXIN_DISABLE_LINEARIZATION_PLAN") === "1" ||
            envFlag("TS_MIXIN_DISABLE_LINEARIZATION_PLAN") === "true"
    }
}

function envFlag(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}

function normalizeStaticCollisionCheck(
    value: MixinClassTransformerConfig["staticCollisionCheck"]
): StaticCollisionCheckMode {
    if (value === undefined) {
        return defaultTransformOptions.staticCollisionCheck
    }

    if (value === true) {
        return "strict"
    }

    return value
}

function normalizeFillMissedInitializers(
    value: MixinClassTransformerConfig["fillMissedInitializersWith"]
): FillMissedInitializersWith {
    if (value === undefined) {
        return defaultTransformOptions.fillMissedInitializersWith
    }

    if (value !== "undefined" && value !== "null" && value !== "nothing") {
        throw new Error(
            `ts-mixin-class: unknown "fillMissedInitializersWith" option ${JSON.stringify(value)}, ` +
            `expected "undefined", "null", or "nothing".`
        )
    }

    return value
}

export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: MixinClassTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const compilerOptions           = program.getCompilerOptions()
    const compilerHost              = host ?? tsInstance.createCompilerHost(compilerOptions)
    const options                   = resolveTransformOptions(config, effectiveUseDefineForClassFields(tsInstance, compilerOptions))
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
    ), program, nativeDiagnostics)
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
    const options              = resolveTransformOptions(config, effectiveUseDefineForClassFields(tsInstance, compilerOptions))
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

// [PROTOTYPE] A generated `<Name>Config` alias is a synthetic sibling whose `.original` was
// set to the owning class (`positionConstructionConfigAlias`); a user `type X = …` resolves
// `getOriginalNode` to itself, so the class-original test isolates exactly the generated ones.
function isGeneratedConfigAlias(
    tsInstance: TypeScript,
    statement: ts.Statement
): statement is ts.TypeAliasDeclaration {
    return tsInstance.isTypeAliasDeclaration(statement) &&
        tsInstance.isClassDeclaration(tsInstance.getOriginalNode(statement))
}

// [PROTOTYPE] Source view preserves the original file text, so a generated `<Name>Config`
// alias has no real "<Name>Config" substring to read — TypeScript's alias display reads the
// name node's SOURCE TEXT, so a synthetic alias renders as `}`. Append each generated alias
// as REAL text past the original end and swap the synthetic alias nodes for the reparsed,
// real-positioned ones. Appending never shifts the [0, N) offsets, so user-code nodes stay
// correct; the alias name now reads natively (incl. generics, e.g. `BoxConfig<number>`). The
// trade-off: the appended region is live for the language service (find-references / rename /
// definition land there) — a paired LS plugin drops navigation spans past the document end.
function appendGeneratedConfigAliasesAsRealText(
    tsInstance: TypeScript,
    transformed: ts.SourceFile,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
    fileName: string
): ts.SourceFile {
    const aliases = transformed.statements.filter(
        (statement): statement is ts.TypeAliasDeclaration => isGeneratedConfigAlias(tsInstance, statement)
    )

    if (aliases.length === 0) {
        return transformed
    }

    const printer      = tsInstance.createPrinter({ removeComments: true })
    const aliasText    = aliases
        .map((alias) => printer.printNode(
            tsInstance.EmitHint.Unspecified, deepCloneNode(tsInstance, alias), transformed
        ))
        .join("\n")
    const combinedText = `${transformed.text}\n${aliasText}\n`

    // Reparse the combined text purely to obtain the appended aliases with correct, real
    // positions in the [N, …) tail; its leading (re-parsed user) statements are discarded.
    const reparsed    = tsInstance.createSourceFile(
        fileName, combinedText, languageVersionOrOptions, true, scriptKindFromFileName(tsInstance, fileName)
    )
    const realAliases = reparsed.statements.slice(reparsed.statements.length - aliases.length)
    const aliasSet    = new Set<ts.Statement>(aliases)
    const kept        = transformed.statements.filter((statement) => !aliasSet.has(statement))
    const grafted     = tsInstance.factory.createNodeArray([ ...kept, ...realAliases ])

    tsInstance.setTextRange(grafted, { pos: kept[0]?.pos ?? 0, end: combinedText.length })

    const mutable = transformed as {
        text           : string,
        end            : number,
        lineMap?       : readonly number[],
        endOfFileToken : ts.Token<ts.SyntaxKind.EndOfFileToken>,
        statements     : ts.NodeArray<ts.Statement>
    }

    mutable.text    = combinedText
    mutable.end     = combinedText.length
    mutable.lineMap = undefined
    tsInstance.setTextRange(mutable.endOfFileToken, { pos: combinedText.length, end: combinedText.length })
    mutable.statements = grafted

    return transformed
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

    // Resolves local base identifiers to cross-file construction-base entries.
    // Built lazily, only when a class actually needs construction-base resolution.
    let baseImportMapCache: Map<string, ImportedNameBinding> | undefined
    const getBaseImportMap = (): Map<string, ImportedNameBinding> | undefined => {
        if (crossFile === undefined) {
            return undefined
        }

        // eslint-disable-next-line align-assignments/align-assignments
        baseImportMapCache ??= buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName, facts)

        return baseImportMapCache
    }

    let expandedAnything      = false
    let needsGeneratedImports = false

    // A class applying a local mixin DECLARED LATER IN THE SAME statement list: plain TS allows
    // it (`implements` is type-only), but the expansion generates a VALUE reference to the mixin
    // const, which module/block evaluation hits while still in the TDZ. TypeScript's own TS2448
    // fires only on the emit plane and remaps to a misleading position (a fully-generated line
    // falls back to the nearest preceding mapping — the import line), and the source-view plane
    // reports nothing — so push a NATIVE diagnostic spanned on the heritage reference. A use from
    // a DIFFERENT (deferred) scope — e.g. a function body applying a later top-level mixin — is
    // legal at runtime (the parents differ), and an imported mixin has no declaration here.
    // (Known lexical corner: `byLocalName` is first-name-wins, so a nested class shadowed by the
    // resolved top-level name can slip through — the emit-plane TS2448 still catches it.)
    const pushMixinUsedBeforeDeclarationDiagnostics = (classFacts: ClassFacts, statement: ts.Statement): void => {
        for (const heritageType of localMixinHeritageTypesFromFacts(tsInstance, classFacts, context)) {
            const expression = heritageType.expression

            if (!tsInstance.isIdentifier(expression)) {
                continue
            }

            const appliedDeclaration = context.byLocalName.get(expression.text)?.declaration

            if (
                appliedDeclaration === undefined ||
                appliedDeclaration.parent !== statement.parent ||
                appliedDeclaration.pos <= statement.pos
            ) {
                continue
            }

            const start = expression.getStart(sourceFile)

            context.nativeDiagnostics.push({
                fileName    : sourceFile.fileName,
                start,
                length      : expression.getEnd() - start,
                code        : mixinDiagnosticCode.MixinUsedBeforeDeclaration,
                category    : tsInstance.DiagnosticCategory.Error,
                messageText : "Mixin used before its declaration. " +
                    `Class ${classFacts.name ?? "<anonymous>"} implements ${expression.text}, ` +
                    `but @mixin ${expression.text} is declared later in the same scope, so the generated ` +
                    "runtime reference would run before the mixin's definition. " +
                    "Declare the mixin before the class that applies it."
            })
        }
    }

    // A namespace MERGED with a `@mixin` class (the static-helper pattern): plain TS allows the
    // class+namespace merge, but the transformer rewrites the mixin class into a `const`, and a
    // namespace cannot merge with a variable — the merge silently loses the namespace exports
    // from the mixin's value type. A namespace whose body is TYPE-ONLY keeps working (qualified
    // type access needs no value merge), so only an INSTANTIATED one is diagnosed.
    const isTypeOnlyModuleBody = (body: ts.ModuleDeclaration["body"]): boolean => {
        if (body === undefined) {
            return true
        }

        if (tsInstance.isModuleBlock(body)) {
            return body.statements.every((inner) =>
                tsInstance.isInterfaceDeclaration(inner) ||
                tsInstance.isTypeAliasDeclaration(inner) ||
                tsInstance.isModuleDeclaration(inner) && isTypeOnlyModuleBody(inner.body))
        }

        return tsInstance.isModuleDeclaration(body) && isTypeOnlyModuleBody(body.body)
    }

    // A prescan over each statement LIST (merging is same-scope only, and namespaces live at
    // the top level or in module blocks) — statement `parent` pointers are not reliable in the
    // emit path, so the list itself is walked instead.
    const pushMixinNamespaceMergeDiagnostics = (statements: readonly ts.Statement[]): void => {
        for (const statement of statements) {
            if (tsInstance.isModuleDeclaration(statement) &&
                statement.body !== undefined && tsInstance.isModuleBlock(statement.body)
            ) {
                pushMixinNamespaceMergeDiagnostics(statement.body.statements)
            }

            if (!tsInstance.isClassDeclaration(statement)) {
                continue
            }

            const classFacts = facts.classesByDeclaration.get(statement)

            if (classFacts?.hasMixinDecorator !== true || classFacts.name === undefined) {
                continue
            }

            for (const sibling of statements) {
                if (!tsInstance.isModuleDeclaration(sibling) ||
                    !tsInstance.isIdentifier(sibling.name) ||
                    sibling.name.text !== classFacts.name ||
                    isTypeOnlyModuleBody(sibling.body)
                ) {
                    continue
                }

                const start = sibling.name.getStart(sourceFile)

                context.nativeDiagnostics.push({
                    fileName    : sourceFile.fileName,
                    start,
                    length      : sibling.name.getEnd() - start,
                    code        : mixinDiagnosticCode.MixinNamespaceMerge,
                    category    : tsInstance.DiagnosticCategory.Error,
                    messageText : `Namespace ${classFacts.name} merges with mixin class ${classFacts.name}, ` +
                        "which is not supported: the transformer rewrites the mixin class into a const, and a " +
                        "namespace cannot merge with it. Declare the helpers as static members of the mixin class instead."
                })
            }
        }
    }

    // Instance member KINDS of a mixin class: accessor names vs data-field names (including
    // constructor parameter properties). Used to mirror TypeScript's own TS2610/TS2611
    // kind-mismatch override guards, which the generated interface cannot carry (the checker
    // only applies them when the base member is declared in a CLASS).
    const mixinInstanceMemberKinds = (declaration: ts.ClassDeclaration): { accessors: Set<string>, fields: Set<string> } => {
        const accessors = new Set<string>()
        const fields    = new Set<string>()

        for (const member of declaration.members) {
            if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword)) {
                continue
            }

            if (tsInstance.isConstructorDeclaration(member)) {
                for (const parameter of member.parameters) {
                    if (tsInstance.isParameterPropertyDeclaration(parameter, member) &&
                        tsInstance.isIdentifier(parameter.name)
                    ) {
                        fields.add(parameter.name.text)
                    }
                }
                continue
            }

            if (member.name === undefined || tsInstance.isPrivateIdentifier(member.name)) {
                continue
            }

            const name = tsInstance.isIdentifier(member.name) || tsInstance.isStringLiteral(member.name)
                ? member.name.text
                : undefined

            if (name === undefined) {
                continue
            }

            if (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) {
                accessors.add(name)
            } else if (tsInstance.isPropertyDeclaration(member)) {
                fields.add(name)
            }
        }

        return { accessors, fields }
    }

    // Mirrors plain TypeScript's TS2610/TS2611: overriding an ACCESSOR with an instance FIELD
    // (or a field with an accessor) is rejected for ordinary class bases, unconditionally —
    // but the checker only fires those when the base member is declared in a class, and a
    // mixin's members reach the consumer through the generated INTERFACE, where accessor-ness
    // does not count. Re-created here on the native channel, covering:
    // - the class's OWN members against every applied mixin (incl. transitively through a
    //   LOCAL `extends` chain of consumers),
    // - mixin-vs-mixin overlaps in one `implements` list (the FIRST-listed mixin is the
    //   nearest layer — §2.6 — so it is the overriding side).
    // A ref without a program-local declaration (a `.d.ts` mixin) cannot be inspected — skipped.
    const pushMixinMemberKindOverrideDiagnostics = (classFacts: ClassFacts, statement: ts.Statement): void => {
        const appliedRefs: { name: string, declaration: ts.ClassDeclaration }[] = []
        const seen                                                              = new Set<string>()
        let cursor: ClassFacts | undefined                                      = classFacts

        while (cursor !== undefined) {
            for (const heritageType of localMixinHeritageTypesFromFacts(tsInstance, cursor, context)) {
                const expression = heritageType.expression as ts.Identifier
                const applied    = context.byLocalName.get(expression.text)?.declaration

                if (applied !== undefined && !seen.has(expression.text)) {
                    seen.add(expression.text)
                    appliedRefs.push({ name: expression.text, declaration: applied })
                }
            }

            const baseExpression: ts.Expression | undefined = cursor.extendsType?.expression

            cursor = undefined

            if (baseExpression !== undefined && tsInstance.isIdentifier(baseExpression) &&
                !seen.has("extends:" + baseExpression.text)
            ) {
                seen.add("extends:" + baseExpression.text)
                cursor = facts.classesByName.get(baseExpression.text)
            }
        }

        if (appliedRefs.length === 0) {
            return
        }

        const kindsOf   = appliedRefs.map((ref) => mixinInstanceMemberKinds(ref.declaration))
        const className = classFacts.name ?? "<anonymous>"

        const push = (node: ts.Node, message: string): void => {
            const start = node.getStart(sourceFile)

            context.nativeDiagnostics.push({
                fileName    : sourceFile.fileName,
                start,
                length      : node.getEnd() - start,
                code        : mixinDiagnosticCode.MixinMemberKindOverride,
                category    : tsInstance.DiagnosticCategory.Error,
                messageText : message
            })
        }

        // The class's OWN members against every applied mixin.
        for (const member of (tsInstance.isClassDeclaration(statement) ? statement.members : [])) {
            if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
                member.name === undefined ||
                !(tsInstance.isIdentifier(member.name) || tsInstance.isStringLiteral(member.name))
            ) {
                continue
            }

            const name = member.name.text

            for (const [ index, ref ] of appliedRefs.entries()) {
                if (tsInstance.isPropertyDeclaration(member) && kindsOf[index].accessors.has(name)) {
                    push(member.name, `Invalid mixin member override. '${name}' is defined as an accessor ` +
                        `in mixin ${ref.name}, but is overridden in ${className} as an instance property. ` +
                        "An instance field would bury the mixin's accessor; declare a get/set pair instead.")
                }

                // Accessor-over-field is gated on DEFINE semantics: under set semantics the
                // deeper field's `this.x = …` assignment fires the overriding setter, so the
                // pattern is sound and stays legal (deliberate deviation from plain TS2611).
                if (resolvedOptions.useDefineForClassFields &&
                    (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) &&
                    kindsOf[index].fields.has(name)
                ) {
                    push(member.name, `Invalid mixin member override. '${name}' is defined as a property ` +
                        `in mixin ${ref.name}, but is overridden in ${className} as an accessor. ` +
                        "The mixin's field initializer would bury the accessor; declare a field instead.")
                }
            }
        }

        // Mixin-vs-mixin overlaps: the FIRST-listed mixin is the nearest (overriding) layer.
        for (let near = 0; near < appliedRefs.length; near++) {
            for (let deep = near + 1; deep < appliedRefs.length; deep++) {
                for (const name of kindsOf[near].fields) {
                    if (kindsOf[deep].accessors.has(name)) {
                        push(statement, `Invalid mixin member override. '${name}' is defined as an accessor ` +
                            `in mixin ${appliedRefs[deep].name}, but mixin ${appliedRefs[near].name} (a nearer ` +
                            `layer of ${className}) re-declares it as an instance property, which would bury the accessor.`)
                    }
                }

                for (const name of kindsOf[near].accessors) {
                    if (resolvedOptions.useDefineForClassFields && kindsOf[deep].fields.has(name)) {
                        push(statement, `Invalid mixin member override. '${name}' is defined as a property ` +
                            `in mixin ${appliedRefs[deep].name}, but mixin ${appliedRefs[near].name} (a nearer ` +
                            `layer of ${className}) re-declares it as an accessor, which the deeper field ` +
                            "initializer would bury at construction time.")
                    }
                }
            }
        }
    }

    const expandClassStatement = (statement: ts.Statement): ts.Statement[] => {
        const classFacts = tsInstance.isClassDeclaration(statement)
            ? facts.classesByDeclaration.get(statement)
            : undefined

        if (classFacts !== undefined) {
            pushMixinUsedBeforeDeclarationDiagnostics(classFacts, statement)
            pushMixinMemberKindOverrideDiagnostics(classFacts, statement)
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
            const expanded = expandClassStatement(statement)

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

    pushMixinNamespaceMergeDiagnostics(sourceFile.statements)

    // A mixin / consumer declared inside a function body or block expands too: walk into nested
    // statement lists and splice the generated siblings into the CONTAINING block (never module
    // scope). No-op-safe — a file with no nested class keeps the original flat, top-level pass.
    const expandedStatements = facts.hasNestedClasses
        ? [ ...expandStatementList(sourceFile.statements) ]
        : sourceFile.statements.flatMap(expandClassStatement)

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
    baseImportMap: Map<string, ImportedNameBinding> | undefined
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
                tsInstance.isIdentifier(heritageType.expression) && context.byLocalName.has(heritageType.expression.text)
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
    const start   = keyword.getStart(sourceFile)

    return {
        fileName : sourceFile.fileName,
        start,
        length   : keyword.getEnd() - start,
        code,
        category : tsInstance.DiagnosticCategory.Error,
        messageText
    }
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
        return classFacts.implementsIdentifierNames.length > 0
    }) && (hasMixinDecoratorImports || crossFile !== undefined)
    const hasPotentialConstructionConfig = candidateClasses.some((classFacts) => classFacts.extendsType !== undefined) &&
        (
            importsPackageBase(tsInstance, facts, options) ||
            extendsCrossFileConstructionBase(tsInstance, sourceFile, facts, crossFile)
        )

    return hasMixinDeclaration || hasPotentialConsumer || hasPotentialConstructionConfig
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

    const extendsNames = facts.classes.flatMap((classFacts) => {
        const expression = classFacts.extendsType?.expression

        return expression !== undefined && tsInstance.isIdentifier(expression) ? [ expression.text ] : []
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

function resolveUsePrintedSourceFile(
    config: MixinClassTransformerConfig,
    compilerOptions: ts.CompilerOptions
): boolean {
    const mode = config.mode

    if (mode === undefined) {
        if (isTypeScriptServerProcess()) {
            return false
        }

        return shouldCreatePrintedSourceFileForEmit(compilerOptions)
    }

    if (mode !== "emit" && mode !== "ide") {
        throw new Error(`ts-mixin-class: unknown "mode" option ${JSON.stringify(mode)}, expected "emit" or "ide".`)
    }

    return mode === "emit"
}

function shouldCreatePrintedSourceFileForEmit(compilerOptions: ts.CompilerOptions): boolean {
    return !compilerOptions.noEmit && !isTypeScriptServerProcess()
}

function isTypeScriptServerProcess(): boolean {
    const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? []

    return argv.some((argument) => {
        const fileName = argument.replaceAll("\\", "/").split("/").at(-1)

        return fileName === "tsserver.js" || fileName === "_tsserver.js"
    })
}
