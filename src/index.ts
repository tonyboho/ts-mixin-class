import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"
import { expandConsumerClass } from "./consumer-expand.js"
import { brandedConstructionBaseHeritage } from "./consumer-base-heritage.js"
import { rewritePublicOnlyUndefinedInitializerClass } from "./construction-initializers.js"
import {
    createConstructionMembers,
    importsPackageBase,
    isConstructionBaseOptIn,
    positionConstructionConfigAlias,
    resolveCrossFileConstructionBase
} from "./construction-config.js"
import { buildFileMixinContext, buildImportedNameMap } from "./context.js"
import { createMixinDeclarationDiagnosticAliases } from "./expand-util.js"
import { expandMixinClass } from "./mixin-expand.js"
import { localMixinHeritageTypesFromFacts } from "./mixin-refs.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import {
    anyConstructorName,
    classStaticsName,
    defaultTransformOptions,
    defineMixinClassName,
    metadataBaseImportName,
    metadataBaseLocalName,
    mixinApplicationName,
    mixinChainName,
    mixinClassValueName,
    mixinFactoryName,
    runtimeMixinClassName,
    shouldSkipFileName,
    staticConflictKeysName,
    type CrossFileContext,
    type FileMixinContext,
    type ImportedNameBinding,
    type MixinClassTransformerConfig,
    type StaticCollisionCheckMode,
    type TransformOptions
} from "./model.js"
import { buildConstructionBaseRegistry, buildMixinRegistry, hasRuntimeModuleForDeclaration } from "./registry.js"
import {
    cloneLayeredSourceFileForTransform,
    alignGeneratedNavigableNodesWithParseTree,
    cloneSourceFileForTransform,
    generatedTextRange,
    hasDifferentAstShape,
    preserveTextRange,
    preserveTopLevelStatementRanges,
    printSourceFileWithMappings,
    scriptKindFromFileName,
    setParentRecursivePreservingVersion,
    zeroWidthRange
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

// Wrap the diagnostic getters tsc reports through so emit-path positions point at the
// real source. `getSyntacticDiagnostics` (DiagnosticWithLocation) stays well-typed
// because the remap keeps a `file`. `emit` carries declaration-emit diagnostics.
function wrapProgramDiagnostics(tsInstance: TypeScript, program: ts.Program): ts.Program {
    const originalGetSyntactic   = program.getSyntacticDiagnostics.bind(program)
    const originalGetSemantic    = program.getSemanticDiagnostics.bind(program)
    const originalGetDeclaration = program.getDeclarationDiagnostics.bind(program)
    const originalEmit           = program.emit.bind(program)

    program.getSyntacticDiagnostics   = (sourceFile, cancellationToken) => {
        return remapDiagnostics(tsInstance, originalGetSyntactic(sourceFile, cancellationToken))
    }
    program.getSemanticDiagnostics    = (sourceFile, cancellationToken) => {
        return remapDiagnostics(tsInstance, originalGetSemantic(sourceFile, cancellationToken))
    }
    program.getDeclarationDiagnostics = (sourceFile, cancellationToken) => {
        return remapDiagnostics(tsInstance, originalGetDeclaration(sourceFile, cancellationToken))
    }
    program.emit                      = (targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers) => {
        const result = originalEmit(targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers)

        return {
            ...result,
            diagnostics : remapDiagnostics(tsInstance, result.diagnostics)
        }
    }

    return program
}

function resolveTransformOptions(config: MixinClassTransformerConfig): TransformOptions {
    return {
        packageName          : config.packageName ?? defaultTransformOptions.packageName,
        decoratorName        : config.decoratorName ?? defaultTransformOptions.decoratorName,
        sourceView           : false,
        staticCollisionCheck : normalizeStaticCollisionCheck(config.staticCollisionCheck),
        allowUndefinedForRequiredProperties :
            config.allowUndefinedForRequiredProperties ??
            defaultTransformOptions.allowUndefinedForRequiredProperties
    }
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

export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: MixinClassTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const compilerOptions           = program.getCompilerOptions()
    const compilerHost              = host ?? tsInstance.createCompilerHost(compilerOptions)
    const options                   = resolveTransformOptions(config)
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
    const crossFile         = registry.size === 0 && constructionBases.size === 0
        ? undefined
        : {
            registry,
            constructionBases,
            cacheKey           : registryCacheKey(registry, constructionBases),
            resolveModuleFileName,
            canImportRuntimeValue,
            linearizationCache : new Map<string, string[]>()
        }
    const nextHost          = createMixinClassCompilerHost(tsInstance, compilerHost, compilerOptions, config, crossFile, program)

    return wrapProgramDiagnostics(tsInstance, tsInstance.createProgram(
        program.getRootFileNames(),
        compilerOptions,
        nextHost,
        undefined
    ))
}

export function createMixinClassCompilerHost(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    compilerOptions: ts.CompilerOptions,
    config: MixinClassTransformerConfig,
    crossFile?: CrossFileContext,
    baseProgram?: ts.Program
): ts.CompilerHost {
    const options              = resolveTransformOptions(config)
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

                const transformedSourceFile = transformSourceFile(tsInstance, sourceFile, options, crossFile)

                if (transformedSourceFile === sourceFile) {
                    setCachedSourceFile(sourceCache, sourceFile, cacheKey, sourceFile)
                    return sourceFile
                }

                const printed           = printSourceFileWithMappings(tsInstance, transformedSourceFile)
                const printedSourceFile = tsInstance.createSourceFile(
                    fileName,
                    printed.text,
                    languageVersionOrOptions,
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
            }, crossFile)

            if (transformedSourceFile === transformSourceFileInput) {
                return cachePreserveSourceFile(sourceFile)
            }

            preserveTopLevelStatementRanges(tsInstance, transformedSourceFile)

            const reparented = setParentRecursivePreservingVersion(tsInstance, transformedSourceFile, sourceFile)

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
    crossFile?: CrossFileContext
): ts.SourceFile {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    if (!transformAppliesToSourceFile(tsInstance, sourceFile, resolvedOptions, crossFile)) {
        return sourceFile
    }

    const facts                 = getSourceFileFacts(tsInstance, sourceFile, resolvedOptions)
    const mixinDecoratorImports = facts.mixinDecoratorImports
    const context               = buildFileMixinContext(
        tsInstance, sourceFile, mixinDecoratorImports, resolvedOptions, crossFile, facts
    )

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

    const expandedStatements = sourceFile.statements.flatMap((statement): ts.Statement[] => {
        const classFacts = tsInstance.isClassDeclaration(statement)
            ? facts.classesByDeclaration.get(statement)
            : undefined

        if (classFacts !== undefined && classFacts.name === undefined && classFacts.hasMixinDecorator) {
            expandedAnything = true
            return anonymousClassDiagnosticStatements(
                tsInstance,
                classFacts.declaration,
                "AnonymousDefaultMixin",
                "Invalid mixin class declaration. A default-exported mixin class must be named. " +
                    "Write `export default class MyMixin` so the transformer can generate stable interface, factory, registry, and declaration names."
            )
        }

        if (classFacts !== undefined && classFacts.name === undefined &&
            localMixinHeritageTypesFromFacts(tsInstance, classFacts, context).length > 0
        ) {
            expandedAnything = true
            return anonymousClassDiagnosticStatements(
                tsInstance,
                classFacts.declaration,
                "AnonymousMixinConsumer",
                "Invalid mixin consumer declaration. A mixin consumer class must be named. " +
                    "Write `class Consumer implements Mixin` or `export default class Consumer implements Mixin` " +
                    "so the transformer can generate stable intermediate base, diagnostic, and declaration names."
            )
        }

        if (classFacts !== undefined && classFacts.name !== undefined) {
            const ref = context.byLocalName.get(classFacts.name)

            if (ref !== undefined && ref.declaration === statement) {
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
    })

    if (!expandedAnything) {
        return sourceFile
    }

    return tsInstance.factory.updateSourceFile(
        sourceFile,
        needsGeneratedImports
            ? insertGeneratedImports(tsInstance, expandedStatements, context, resolvedOptions)
            : expandedStatements
    )
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
    const rewritten    = rewritePublicOnlyUndefinedInitializerClass(tsInstance, declaration, options)
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

function anonymousClassDiagnosticStatements(
    tsInstance: TypeScript,
    statement: ts.ClassDeclaration,
    generatedBaseName: string,
    message: string
): ts.Statement[] {
    return [
        ...createMixinDeclarationDiagnosticAliases(
            tsInstance,
            generatedBaseName,
            [ {
                node : statement,
                message
            } ],
            statement
        ),
        statement
    ]
}

// Generated imports (type helpers + mixin factories from other modules) are
// inserted after the last original import.
function insertGeneratedImports(
    tsInstance: TypeScript,
    statements: ts.Statement[],
    context: FileMixinContext,
    options: TransformOptions
): ts.Statement[] {
    const factory = tsInstance.factory

    const generatedImports: ts.ImportDeclaration[] = [ createHelperTypeImport(tsInstance, context, options) ]

    const bySpecifier = new Map<string, Array<{ importedName: string, localName: string }>>()

    for (const factoryImport of context.usedFactoryImports.values()) {
        const elements = bySpecifier.get(factoryImport.specifier) ?? []

        elements.push(factoryImport)
        bySpecifier.set(factoryImport.specifier, elements)
    }

    for (const [ specifier, elements ] of bySpecifier) {
        generatedImports.push(factory.createImportDeclaration(
            undefined,
            factory.createImportClause(
                undefined,
                undefined,
                factory.createNamedImports(elements.map((element) => {
                    return factory.createImportSpecifier(
                        false,
                        element.importedName === element.localName
                            ? undefined
                            : factory.createIdentifier(element.importedName),
                        factory.createIdentifier(element.localName)
                    )
                }))
            ),
            factory.createStringLiteral(specifier)
        ))
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

function createHelperTypeImport(
    tsInstance: TypeScript,
    context: FileMixinContext,
    options: TransformOptions
): ts.ImportDeclaration {
    const factory              = tsInstance.factory
    const staticConflictImport = options.staticCollisionCheck === false
        ? []
        : [
            factory.createImportSpecifier(
                true,
                undefined,
                factory.createIdentifier(staticConflictKeysName(options.staticCollisionCheck))
            )
        ]

    return factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
            undefined,
            undefined,
            factory.createNamedImports([
                factory.createImportSpecifier(false, undefined, factory.createIdentifier(defineMixinClassName)),
                factory.createImportSpecifier(false, undefined, factory.createIdentifier(mixinChainName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(anyConstructorName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(classStaticsName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(mixinApplicationName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(mixinFactoryName)),
                ...staticConflictImport,
                factory.createImportSpecifier(
                    true,
                    factory.createIdentifier(metadataBaseImportName),
                    factory.createIdentifier(metadataBaseLocalName)
                ),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(runtimeMixinClassName)),
                factory.createImportSpecifier(true, undefined, factory.createIdentifier(mixinClassValueName))
            ])
        ),
        factory.createStringLiteral(options.packageName)
    )
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
    const hasMixinDecoratorImports       = facts.mixinDecoratorImports.identifiers.size > 0 ||
        facts.mixinDecoratorImports.namespaces.size > 0
    const hasMixinDeclaration            = hasMixinDecoratorImports &&
        facts.classes.some((classFacts) => classFacts.hasMixinDecorator)
    const hasPotentialConsumer           = facts.classes.some((classFacts) => {
        return classFacts.implementsIdentifierNames.length > 0
    }) && (hasMixinDecoratorImports || crossFile !== undefined)
    const hasPotentialConstructionConfig = facts.classes.some((classFacts) => classFacts.extendsType !== undefined) &&
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
        String(options.allowUndefinedForRequiredProperties),
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
