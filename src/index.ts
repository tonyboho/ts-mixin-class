import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"
import { expandConsumerClass } from "./consumer-expand.js"
import { rewritePublicOnlyUndefinedInitializerClass } from "./construction-initializers.js"
import {
    createConstructionMembers,
    importsPackageBase,
    isConstructionBaseOptIn,
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
    cloneSourceFileForTransform,
    generatedTextRange,
    hasDifferentAstShape,
    preserveTextRange,
    preserveTopLevelStatementRanges,
    printSourceFile,
    scriptKindFromFileName,
    setParentRecursivePreservingVersion,
    zeroWidthRange
} from "./util.js"
import type { TypeScript } from "./util.js"

export * from "./base.js"
export * from "./runtime.js"
export type {
    ConstructionConfigMode,
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

function resolveTransformOptions(config: MixinClassTransformerConfig): TransformOptions {
    return {
        packageName          : config.packageName ?? defaultTransformOptions.packageName,
        decoratorName        : config.decoratorName ?? defaultTransformOptions.decoratorName,
        sourceView           : false,
        staticCollisionCheck : normalizeStaticCollisionCheck(config.staticCollisionCheck),
        constructionConfig   : config.constructionConfig ?? defaultTransformOptions.constructionConfig,
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
    const compilerOptions = program.getCompilerOptions()
    const compilerHost    = host ?? tsInstance.createCompilerHost(compilerOptions)
    const options         = resolveTransformOptions(config)
    const resolvedModuleFileNames = new Map<string, string | undefined>()
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
    const constructionBases = buildConstructionBaseRegistry(tsInstance, program, options, resolveModuleFileName)
    const crossFile = registry.size === 0 && constructionBases.size === 0
        ? undefined
        : {
            registry,
            constructionBases,
            cacheKey : registryCacheKey(registry, constructionBases),
            resolveModuleFileName,
            canImportRuntimeValue,
            linearizationCache : new Map<string, string[]>()
        }
    const nextHost  = createMixinClassCompilerHost(tsInstance, compilerHost, compilerOptions, config, crossFile, program)

    return tsInstance.createProgram(
        program.getRootFileNames(),
        compilerOptions,
        nextHost,
        undefined
    )
}

export function createMixinClassCompilerHost(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    compilerOptions: ts.CompilerOptions,
    config: MixinClassTransformerConfig,
    crossFile?: CrossFileContext,
    baseProgram?: ts.Program
): ts.CompilerHost {
    const options = resolveTransformOptions(config)
    const sourceCache = new WeakMap<ts.SourceFile, Map<string, ts.SourceFile>>()
    const usePrintedSourceFile = resolveUsePrintedSourceFile(config, compilerOptions)

    return {
        ...compilerHost,

        getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) {
            const layeredSourceFile = baseProgram?.getSourceFile(fileName)
            const preserveCacheKey = usePrintedSourceFile
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
            const sourceFile = useLayeredSourceFile ? layeredSourceFile : hostSourceFile

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

                const printedSourceFile = tsInstance.createSourceFile(
                    fileName,
                    printSourceFile(tsInstance, transformedSourceFile),
                    languageVersionOrOptions,
                    true,
                    scriptKindFromFileName(tsInstance, fileName)
                )

                setCachedSourceFile(sourceCache, sourceFile, cacheKey, printedSourceFile)

                return printedSourceFile
            }

            const transformSourceFileInput = useLayeredSourceFile
                ? cloneLayeredSourceFileForTransform(tsInstance, sourceFile)
                : cloneSourceFileForTransform(tsInstance, sourceFile, languageVersionOrOptions)
            const transformedSourceFile = transformSourceFile(tsInstance, transformSourceFileInput, {
                ...options,
                sourceView : true
            }, crossFile)

            if (transformedSourceFile === transformSourceFileInput) {
                return cachePreserveSourceFile(sourceFile)
            }

            preserveTopLevelStatementRanges(tsInstance, transformedSourceFile)

            return cachePreserveSourceFile(setParentRecursivePreservingVersion(tsInstance, transformedSourceFile, sourceFile))
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

        baseImportMapCache ??= buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName, facts)

        return baseImportMapCache
    }

    let expandedAnything = false
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
                expandedAnything = true
                needsGeneratedImports = true
                return expandMixinClass(tsInstance, sourceFile, ref, context, resolvedOptions)
            }

            const mixinHeritage = localMixinHeritageTypesFromFacts(tsInstance, classFacts, context)

            if (mixinHeritage.length > 0) {
                expandedAnything = true
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
                const expandedStatement = expandConstructionBaseClass(
                    tsInstance,
                    sourceFile,
                    classFacts.declaration,
                    resolvedOptions,
                    crossFile,
                    getBaseImportMap()
                )

                if (expandedStatement !== statement) {
                    expandedAnything = true
                    return [ expandedStatement ]
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
): ts.ClassDeclaration {
    const rewritten = rewritePublicOnlyUndefinedInitializerClass(tsInstance, declaration, options)
    const constructionMembers = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        declaration.heritageClauses?.find((clause) => {
            return clause.token === tsInstance.SyntaxKind.ExtendsKeyword
        })?.types[0],
        undefined,
        [],
        options,
        options.sourceView
            ? generatedTextRange(sourceFile, declaration.members.end)
            : generatedTextRange(sourceFile, declaration.pos),
        crossFile,
        baseImportMap
    )

    if (constructionMembers.length === 0) {
        return rewritten
    }

    return tsInstance.factory.updateClassDeclaration(
        rewritten,
        rewritten.modifiers,
        rewritten.name,
        rewritten.typeParameters,
        rewritten.heritageClauses,
        preserveTextRange(
            tsInstance,
            tsInstance.factory.createNodeArray([ ...rewritten.members, ...constructionMembers ]),
            rewritten.members
        )
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
    const factory = tsInstance.factory
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
    const hasMixinDecoratorImports = facts.mixinDecoratorImports.identifiers.size > 0 ||
        facts.mixinDecoratorImports.namespaces.size > 0
    const hasMixinDeclaration = hasMixinDecoratorImports &&
        facts.classes.some((classFacts) => classFacts.hasMixinDecorator)
    const hasPotentialConsumer = facts.classes.some((classFacts) => {
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
        options.constructionConfig,
        String(options.allowUndefinedForRequiredProperties),
        crossFile?.cacheKey ?? "",
        languageVersionKey
    ].join("|")
}

function registryCacheKey(
    registry: CrossFileContext["registry"],
    constructionBases: CrossFileContext["constructionBases"]
): string {
    const mixinKey = [ ...registry.entries() ]
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
