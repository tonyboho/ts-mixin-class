import type * as ts from "typescript"
import { attachDiagnosticRemap } from "./emit-diagnostic-remap.js"
import {
    type CrossFileContext,
    type MixinClassTransformerConfig,
    type NativeMixinDiagnostic,
    type TransformOptions
} from "./model.js"
import { shouldSkipFileName } from "./util.js"
import { appendGeneratedConfigAliasesAsRealText } from "./source-view-config-alias.js"
import { preserveTopLevelStatementRanges } from "./text-range.js"
import { effectiveUseDefineForClassFields, resolveTransformOptions, resolveUsePrintedSourceFile } from "./transform-options.js"
import { transformAppliesToSourceFile, transformSourceFile } from "./transform-source-file.js"
import {
    alignGeneratedNavigableNodesWithParseTree,
    cloneLayeredSourceFileForTransform,
    cloneSourceFileForTransform,
    hasDifferentAstShape,
    preserveSourceFileVersion,
    printSourceFileWithMappings,
    scriptKindFromFileName,
    setParentRecursivePreservingVersion,
    sourceFileOptionsPreservingFormat
} from "./util.js"
import type { TypeScript } from "./util.js"

// The compiler host wrapping `getSourceFile`: decides per file whether the transform
// applies, runs it on the right plane (reprinted for emit, position-preserving clone for
// source view) and caches the result — plus the cache keys that scope those entries to
// the transform configuration and registry state.

const preserveSourceCache = new WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>()

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
            const transformedSourceFile    = transformSourceFile(
                tsInstance,
                transformSourceFileInput,
                {
                    ...options,
                    sourceView : true
                },
                crossFile,
                nativeDiagnostics
            )

            if (transformedSourceFile === transformSourceFileInput) {
                return cachePreserveSourceFile(sourceFile)
            }

            // [PROTOTYPE] Append each generated `<Name>Config` alias as REAL text past the
            // original end so the checker reads its real name (diagnostics, error hover AND
            // quickinfo, incl. generics). The phantom appended region is past the document; a
            // paired language-service plugin filters navigation results that land there.
            const withAliasText = appendGeneratedConfigAliasesAsRealText(
                tsInstance,
                transformedSourceFile,
                languageVersionOrOptions,
                fileName
            )

            preserveTopLevelStatementRanges(tsInstance, withAliasText)

            const reparented = setParentRecursivePreservingVersion(tsInstance, withAliasText, sourceFile)

            return cachePreserveSourceFile(alignGeneratedNavigableNodesWithParseTree(tsInstance, reparented))
        }
    }
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

export function registryCacheKey(
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
