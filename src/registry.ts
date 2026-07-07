import type * as ts from "typescript"
import {
    isPackageBaseExpression,
    qualifiedConstructionChainExit,
    type QualifiedBaseChainExit
} from "./construction-chain.js"
import { buildImportedNameMap } from "./context.js"
import {
    type ImportMap,
    importedBindingRegistryKey,
    accumulateRegisteredMixinConfig,
    defaultTransformOptions,
    normalizePath,
    registryKey,
    shouldSkipFileName,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionBaseRegistry,
    type MixinRegistry,
    type TransformOptions
} from "./model.js"
import { collectDeclarationFileConstructionBases, collectDeclarationFileMixinCandidates } from "./registry-declaration-file.js"
import { getSourceFileFacts, type ClassFacts, type SourceFileFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

const registryCandidateCache = new WeakMap<ts.SourceFile, Map<string, Candidate[]>>()

export function buildMixinRegistry(
    tsInstance: TypeScript,
    program: ts.Program,
    options: Partial<TransformOptions> = {},
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined
): MixinRegistry {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    const candidates: Candidate[] = []

    for (const sourceFile of program.getSourceFiles()) {
        if (shouldSkipRegistrySourceFile(sourceFile)) {
            continue
        }

        candidates.push(...cachedSourceFileMixinCandidates(tsInstance, sourceFile, resolvedOptions))
    }

    const registry: MixinRegistry = new Map()

    for (const candidate of candidates) {
        registry.set(registryKey(candidate.sourceFile.fileName, candidate.name), {
            fileName                  : candidate.sourceFile.fileName,
            name                      : candidate.name,
            defaultExport             : candidate.defaultExport,
            dependencies              : [],
            requiredBaseName          : candidate.requiredBaseName,
            requiredBaseIsPackageBase : candidate.requiredBaseIsPackageBase,
            configProperties          : candidate.configProperties
        })

        if (candidate.defaultExport) {
            registry.set(registryKey(candidate.sourceFile.fileName, "default"), registry.get(
                registryKey(candidate.sourceFile.fileName, candidate.name)
            )!)
        }
    }

    // Register re-export aliases so a mixin imported through a barrel resolves: each
    // `export ... from "<module>"` (named, aliased, `export *`, default passthrough,
    // nested) makes the mixin reachable under `registryKey(barrelFile, exportedName)`,
    // pointing at the same entry as its declaring file. Done before dependency resolution
    // so a mixin DEPENDENCY imported via a barrel resolves too.
    addReExportAliasKeys(tsInstance, program, registry)

    const importMaps            = new Map<string, ImportMap>()
    const dependencyNamesByFile = new Map<string, Set<string>>()

    for (const candidate of candidates) {
        const names = dependencyNamesByFile.get(candidate.sourceFile.fileName) ?? new Set<string>()

        for (const dependencyName of candidate.dependencyNames) {
            names.add(dependencyName)
        }

        dependencyNamesByFile.set(candidate.sourceFile.fileName, names)
    }

    // Registry keys a (possibly QUALIFIED) dependency name may resolve to, in priority
    // order: the same file, the named import binding, or — for a dotted `lib.Logger` —
    // the namespace-import member. The first key the registry actually has wins.
    const dependencyCandidateKeys = (
        fileName: string,
        dependencyName: string,
        importMap: ImportMap
    ): string[] => {
        const importedKey = importedBindingRegistryKey(dependencyName, importMap)

        if (dependencyName.includes(".")) {
            return importedKey === undefined ? [] : [ importedKey ]
        }

        const keys = [ registryKey(fileName, dependencyName) ]

        if (importedKey !== undefined) {
            keys.push(importedKey)
        }

        return keys
    }

    for (const candidate of candidates) {
        const fileName = candidate.sourceFile.fileName
        const entry    = registry.get(registryKey(fileName, candidate.name))

        if (entry === undefined) {
            continue
        }

        let importMap = importMaps.get(fileName)

        if (importMap === undefined) {
            importMap = buildImportedNameMap(
                tsInstance,
                candidate.sourceFile,
                resolveModuleFileName,
                getSourceFileFacts(tsInstance, candidate.sourceFile, resolvedOptions),
                dependencyNamesByFile.get(fileName)
            )
            importMaps.set(fileName, importMap)
        }

        for (const dependencyName of candidate.dependencyNames) {
            const resolvedKey = dependencyCandidateKeys(fileName, dependencyName, importMap)
                .find((candidateKey) => registry.has(candidateKey))

            if (resolvedKey !== undefined) {
                entry.dependencies.push(resolvedKey)
                continue
            }

            if (candidate.declarationHeritage && entry.requiredBaseName === undefined && !dependencyName.includes(".")) {
                entry.requiredBaseName = dependencyName
            }
        }
    }

    return registry
}

// Walks every module's `export ... from` re-exports and, for each re-exported mixin,
// adds a registry alias key `registryKey(reExportingFile, exportedName) -> entry`. Uses
// the type-checker (original-program symbols) to follow alias chains — so named, aliased
// (`as`), `export *`, default-passthrough, and nested barrels all resolve uniformly. The
// checker is fetched lazily and only files that actually re-export are inspected, so a
// project of direct imports pays effectively nothing.
function addReExportAliasKeys(
    tsInstance: TypeScript,
    program: ts.Program,
    registry: MixinRegistry
): void {
    let checker: ts.TypeChecker | undefined

    for (const sourceFile of program.getSourceFiles()) {
        const hasReExport = sourceFile.statements.some((statement) =>
            tsInstance.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined)

        if (!hasReExport) {
            continue
        }

        // eslint-disable-next-line align-assignments/align-assignments
        checker ??= program.getTypeChecker()

        const moduleSymbol = checker.getSymbolAtLocation(sourceFile)

        if (moduleSymbol === undefined) {
            continue
        }

        for (const exported of checker.getExportsOfModule(moduleSymbol)) {
            // A named/aliased/default re-export is an alias symbol (follow it); a `export *`
            // re-export surfaces the ORIGINAL symbol directly (not an alias), so resolve the
            // alias only when there is one.
            const target      = (exported.flags & tsInstance.SymbolFlags.Alias) === 0
                ? exported
                : checker.getAliasedSymbol(exported)
            const declaration = target.declarations?.find((node) => tsInstance.isClassDeclaration(node))

            if (declaration === undefined || !tsInstance.isClassDeclaration(declaration) || declaration.name === undefined) {
                continue
            }

            const declaringFileName = declaration.getSourceFile().fileName

            // Only a mixin declared in ANOTHER file is a re-export; a locally-declared
            // export is already registered under its own key.
            if (declaringFileName === sourceFile.fileName) {
                continue
            }

            const entry = registry.get(registryKey(declaringFileName, declaration.name.text))

            if (entry === undefined) {
                continue
            }

            const aliasKey = registryKey(sourceFile.fileName, exported.name)

            if (!registry.has(aliasKey)) {
                registry.set(aliasKey, entry)
            }
        }
    }
}

export type Candidate = {
    sourceFile                : ts.SourceFile,
    name                      : string,
    dependencyNames           : string[],
    requiredBaseName          : string | undefined,
    requiredBaseIsPackageBase : boolean,
    configProperties          : ConfigProperty[],
    declarationHeritage       : boolean,
    defaultExport             : boolean
}

// Program-wide map of ordinary (non-mixin) classes that transitively extend the
// package `Base`. Built once per program so a cross-file `extends`/required-base
// reference can be recognised as a construction base (and its accumulated config
// fields read) without re-analysing the defining file.
export function buildConstructionBaseRegistry(
    tsInstance: TypeScript,
    program: ts.Program,
    options: Partial<TransformOptions> = {},
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined,
    mixinRegistry?: MixinRegistry
): ConstructionBaseRegistry {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    type ConstructionBaseCandidate = {
        fileName                      : string,
        name                          : string,
        baseName                      : string | undefined,
        extendsPackageBase            : boolean,
        // The accumulated config of a QUALIFIED base (`extends data.Model`) resolved
        // through the file's local namespace index. A qualified chain is resolved right
        // here at collection time (nested classes are never candidates themselves), so
        // its contribution rides on the candidate instead of the `resolve` recursion.
        qualifiedBaseConfigProperties : ConfigProperty[],
        ownConfigProperties           : ConfigProperty[],
        mixinDependencyNames          : string[],
        importMap                     : ImportMap
    }

    const candidatesByKey                         = new Map<string, ConstructionBaseCandidate>()
    const candidates: ConstructionBaseCandidate[] = []

    // The candidate key a class's base reference resolves to through the file's imports:
    // a plain identifier through its named-import binding, a dotted name (`lib.Model`)
    // through its namespace-import binding (exactly one dot — candidates are top-level
    // classes of their module). Same-file resolution is the caller's concern.

    // The name a class's base reference contributes to import-level resolution: the
    // identifier text, or — for a QUALIFIED base — where its local chain leaves the file
    // (an imported identifier / the dotted namespace-import member; the package `Base`
    // exit needs no name). The exit walk also carries the chain's local config.
    const classBaseResolution = (
        sourceFile: ts.SourceFile,
        classFacts: ClassFacts,
        facts: SourceFileFacts
    ): { baseName: string | undefined, qualifiedExit: QualifiedBaseChainExit | undefined } => {
        const baseExpression = classFacts.extendsType!.expression

        if (tsInstance.isIdentifier(baseExpression)) {
            return { baseName: baseExpression.text, qualifiedExit: undefined }
        }

        // A QUALIFIED base (`extends data.Model`) is resolved right here at collection
        // time (a nested class is never a candidate itself): the local walk
        // (`qualifiedConstructionChainExit`) follows the chain to where it leaves the
        // file — the package `Base` import, or an unresolved reference that becomes the
        // candidate's `baseName` for the ordinary imported-candidate resolution. The
        // chain's LOCAL levels contribute `qualifiedBaseConfigProperties`; the imported
        // tail comes from `resolve`.
        const qualifiedExit = qualifiedConstructionChainExit(
            tsInstance, sourceFile, classFacts.extendsType!, resolvedOptions, facts
        )

        return { baseName: qualifiedExit?.unresolvedName, qualifiedExit }
    }

    const collectFileCandidates = (sourceFile: ts.SourceFile): void => {
        const facts = getSourceFileFacts(tsInstance, sourceFile, resolvedOptions)
        let importMap: ImportMap | undefined

        for (const classFacts of facts.classes) {
            if (classFacts.name === undefined ||
                classFacts.hasMixinDecorator ||
                classFacts.extendsType === undefined
            ) {
                continue
            }

            // eslint-disable-next-line align-assignments/align-assignments
            importMap ??= buildImportedNameMap(tsInstance, sourceFile, resolveModuleFileName, facts)

            const { baseName, qualifiedExit } = classBaseResolution(sourceFile, classFacts, facts)
            const baseExpression              = classFacts.extendsType.expression

            const candidate: ConstructionBaseCandidate = {
                fileName           : sourceFile.fileName,
                name               : classFacts.name,
                baseName,
                extendsPackageBase : isPackageBaseExpression(tsInstance, baseExpression, resolvedOptions, facts) ||
                    qualifiedExit?.isPackageBase === true,
                qualifiedBaseConfigProperties : qualifiedExit?.configProperties ?? [],
                ownConfigProperties           : classFacts.configProperties,
                mixinDependencyNames          : [
                    ...classFacts.implementsIdentifierNames,
                    ...classFacts.implementsQualifiedNames
                ],
                importMap
            }

            candidates.push(candidate)
            candidatesByKey.set(registryKey(sourceFile.fileName, classFacts.name), candidate)
        }
    }

    // Phase 1: files that mention the package — the cheap text prefilter admits every
    // file that can possibly anchor a chain (the package `Base` import lives in one).
    const packageFreeSourceFiles: ts.SourceFile[] = []

    for (const sourceFile of program.getSourceFiles()) {
        if (shouldSkipRegistrySourceFile(sourceFile) || sourceFile.isDeclarationFile) {
            continue
        }

        if (sourceFile.text.includes(resolvedOptions.packageName)) {
            collectFileCandidates(sourceFile)
        } else {
            packageFreeSourceFiles.push(sourceFile)
        }
    }

    // Phase 2: a construction chain may pass through a PACKAGE-FREE file (one that only
    // imports its base from a sibling module) — its consumers must still be registered
    // or subclassing them from yet another file silently loses construction. Admit, to a
    // fixpoint, every remaining file with a top-level class whose base reference
    // resolves through its imports into an already-collected candidate (files admitted
    // in one round can anchor chains for the next). The raw statement scan keeps the
    // common case cheap: a file with no import or no extending top-level class is
    // dismissed without building facts.
    const chainCandidateFiles = packageFreeSourceFiles.filter((sourceFile) =>
        sourceFile.statements.some((statement) => tsInstance.isImportDeclaration(statement)) &&
        sourceFile.statements.some((statement) =>
            tsInstance.isClassDeclaration(statement) && statement.heritageClauses !== undefined))

    const fileChainsIntoCandidates = (sourceFile: ts.SourceFile): boolean => {
        const facts = getSourceFileFacts(tsInstance, sourceFile, resolvedOptions)
        let importMap: ImportMap | undefined

        for (const classFacts of facts.classes) {
            if (classFacts.name === undefined ||
                classFacts.hasMixinDecorator ||
                classFacts.extendsType === undefined
            ) {
                continue
            }

            const { baseName } = classBaseResolution(sourceFile, classFacts, facts)

            if (baseName === undefined) {
                continue
            }

            // eslint-disable-next-line align-assignments/align-assignments
            importMap ??= buildImportedNameMap(tsInstance, sourceFile, resolveModuleFileName, facts)

            const key = importedBindingRegistryKey(baseName, importMap)

            if (key !== undefined && candidatesByKey.has(key)) {
                return true
            }
        }

        return false
    }

    let pendingChainFiles = chainCandidateFiles

    for (;;) {
        const keptChainFiles: ts.SourceFile[] = []
        let admittedAnything                  = false

        for (const sourceFile of pendingChainFiles) {
            if (fileChainsIntoCandidates(sourceFile)) {
                collectFileCandidates(sourceFile)
                admittedAnything = true
            } else {
                keptChainFiles.push(sourceFile)
            }
        }

        if (!admittedAnything || keptChainFiles.length === 0) {
            break
        }

        pendingChainFiles = keptChainFiles
    }

    const resolved = new Map<string, { isBaseDescendant: boolean, configProperties: ConfigProperty[] }>()

    const candidateMixinConfig = (candidate: ConstructionBaseCandidate): ConfigProperty[] => {
        if (mixinRegistry === undefined) {
            return []
        }

        return uniqueConfigProperties(candidate.mixinDependencyNames.flatMap((name) => {
            // Same resolution order as the dependency loop above: same file, then the named
            // import binding or a QUALIFIED `lib.Logger` through its namespace import.
            const keys        = name.includes(".") ? [] : [ registryKey(candidate.fileName, name) ]
            const importedKey = importedBindingRegistryKey(name, candidate.importMap)

            if (importedKey !== undefined) {
                keys.push(importedKey)
            }

            const registeredKey = keys.find((key) => mixinRegistry.has(key))

            return registeredKey === undefined
                ? []
                : accumulateRegisteredMixinConfig(registeredKey, mixinRegistry, new Set())
        }))
    }

    // The construction config an ordinary class contributes on its own: its public
    // fields plus those of every mixin it consumes (transitively). Without the mixin
    // half, subclassing an imported construction *consumer* would drop the base's
    // mixin config from the subclass's `.new`.
    const ownPlusMixinConfig = (candidate: ConstructionBaseCandidate): ConfigProperty[] =>
        uniqueConfigProperties([
            ...candidate.qualifiedBaseConfigProperties,
            ...candidateMixinConfig(candidate),
            ...candidate.ownConfigProperties
        ])

    const resolve = (
        candidate: ConstructionBaseCandidate,
        seen: Set<string>
    ): { isBaseDescendant: boolean, configProperties: ConfigProperty[] } => {
        const key    = registryKey(candidate.fileName, candidate.name)
        const cached = resolved.get(key)

        if (cached !== undefined) {
            return cached
        }

        if (seen.has(key)) {
            return { isBaseDescendant: false, configProperties: ownPlusMixinConfig(candidate) }
        }

        seen.add(key)

        if (candidate.extendsPackageBase) {
            const result = { isBaseDescendant: true, configProperties: ownPlusMixinConfig(candidate) }

            resolved.set(key, result)

            return result
        }

        const baseCandidate = candidate.baseName === undefined
            ? undefined
            : candidatesByKey.get(registryKey(candidate.fileName, candidate.baseName)) ??
                resolveImportedConstructionBaseCandidate(candidate, candidatesByKey)

        if (baseCandidate === undefined) {
            const result = { isBaseDescendant: false, configProperties: ownPlusMixinConfig(candidate) }

            resolved.set(key, result)

            return result
        }

        const baseResolved = resolve(baseCandidate, seen)
        const result       = {
            isBaseDescendant : baseResolved.isBaseDescendant,
            configProperties : uniqueConfigProperties([ ...baseResolved.configProperties, ...ownPlusMixinConfig(candidate) ])
        }

        resolved.set(key, result)

        return result
    }

    function resolveImportedConstructionBaseCandidate(
        candidate: ConstructionBaseCandidate,
        byKey: Map<string, ConstructionBaseCandidate>
    ): ConstructionBaseCandidate | undefined {
        if (candidate.baseName === undefined) {
            return undefined
        }

        const key = importedBindingRegistryKey(candidate.baseName, candidate.importMap)

        return key === undefined ? undefined : byKey.get(key)
    }

    const registry: ConstructionBaseRegistry = new Map()

    for (const candidate of candidates) {
        const entry = resolve(candidate, new Set())

        if (!entry.isBaseDescendant) {
            continue
        }

        registry.set(registryKey(candidate.fileName, candidate.name), {
            fileName         : candidate.fileName,
            name             : candidate.name,
            isBaseDescendant : true,
            configProperties : entry.configProperties
        })
    }

    // Construction bases published as declarations: an emitted `.d.ts` construction
    // class already carries its FULLY aggregated config on the generated `static
    // new(props: Pick<Self, …>)`, so it is registered directly (no recursion needed) and
    // a subclass in another package can read its inherited config from the registry.
    for (const sourceFile of program.getSourceFiles()) {
        if (!sourceFile.isDeclarationFile ||
            shouldSkipRegistrySourceFile(sourceFile) ||
            !sourceFile.text.includes(resolvedOptions.packageName)
        ) {
            continue
        }

        for (const constructionBase of collectDeclarationFileConstructionBases(tsInstance, sourceFile)) {
            registry.set(registryKey(sourceFile.fileName, constructionBase.name), {
                fileName         : sourceFile.fileName,
                name             : constructionBase.name,
                isBaseDescendant : true,
                configProperties : constructionBase.configProperties
            })
        }
    }

    return registry
}

function cachedSourceFileMixinCandidates(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): Candidate[] {
    const cacheKey = registryCandidateCacheKey(sourceFile, options)
    const cached   = registryCandidateCache.get(sourceFile)?.get(cacheKey)

    if (cached !== undefined) {
        return cached
    }

    const candidates      = collectSourceFileMixinCandidates(tsInstance, sourceFile, options)
    const cachedByOptions = registryCandidateCache.get(sourceFile) ?? new Map<string, Candidate[]>()

    cachedByOptions.set(cacheKey, candidates)
    registryCandidateCache.set(sourceFile, cachedByOptions)

    return candidates
}

function collectSourceFileMixinCandidates(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): Candidate[] {
    if (sourceFile.isDeclarationFile) {
        return collectDeclarationFileMixinCandidates(tsInstance, sourceFile, options)
    }

    if (!sourceFile.text.includes(options.packageName)) {
        return []
    }

    const facts = getSourceFileFacts(tsInstance, sourceFile, options)

    if (facts.mixinDecoratorImports.identifiers.size === 0 && facts.mixinDecoratorImports.namespaces.size === 0) {
        return []
    }

    const candidates: Candidate[] = []

    for (const classFacts of facts.classes) {
        if (classFacts.name === undefined || !classFacts.hasMixinDecorator) {
            continue
        }

        candidates.push({
            sourceFile,
            name            : classFacts.name,
            dependencyNames : [
                ...classFacts.implementsIdentifierNames,
                ...classFacts.implementsQualifiedNames
            ],
            requiredBaseName          : classFacts.requiredBaseName,
            requiredBaseIsPackageBase : classFacts.extendsType !== undefined &&
                isPackageBaseExpression(tsInstance, classFacts.extendsType.expression, options, facts),
            configProperties    : classFacts.configProperties,
            declarationHeritage : false,
            defaultExport       : classFacts.defaultExport
        })
    }

    return candidates
}

function registryCandidateCacheKey(sourceFile: ts.SourceFile, options: TransformOptions): string {
    return sourceFile.isDeclarationFile
        ? [ "declaration", options.packageName ].join("|")
        : [ options.packageName, options.decoratorName ].join("|")
}

function shouldSkipRegistrySourceFile(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile) {
        return !/\.[cm]?tsx?$/.test(normalizePath(sourceFile.fileName))
    }

    return shouldSkipFileName(sourceFile.fileName)
}
