import type * as ts from "typescript"
import { isPackageBaseExpression } from "./construction-config.js"
import { buildImportedNameMap } from "./context.js"
import {
    defaultTransformOptions,
    normalizePath,
    propertyNameText,
    registryKey,
    runtimeMixinClassName,
    shouldSkipFileName,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionBaseRegistry,
    type ImportedNameBinding,
    type MixinRegistry,
    type TransformOptions
} from "./model.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import { hasModifier } from "./util.js"
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
            fileName          : candidate.sourceFile.fileName,
            name              : candidate.name,
            defaultExport     : candidate.defaultExport,
            dependencies      : [],
            requiredBaseName  : candidate.requiredBaseName,
            requiredBaseIsPackageBase : candidate.requiredBaseIsPackageBase,
            configProperties    : candidate.configProperties
        })

        if (candidate.defaultExport) {
            registry.set(registryKey(candidate.sourceFile.fileName, "default"), registry.get(
                registryKey(candidate.sourceFile.fileName, candidate.name)
            )!)
        }
    }

    const importMaps = new Map<string, Map<string, { resolvedFileName: string, importedName: string }>>()
    const dependencyNamesByFile = new Map<string, Set<string>>()

    for (const candidate of candidates) {
        const names = dependencyNamesByFile.get(candidate.sourceFile.fileName) ?? new Set<string>()

        for (const dependencyName of candidate.dependencyNames) {
            names.add(dependencyName)
        }

        dependencyNamesByFile.set(candidate.sourceFile.fileName, names)
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
            const sameFileKey = registryKey(fileName, dependencyName)

            if (registry.has(sameFileKey)) {
                entry.dependencies.push(sameFileKey)
                continue
            }

            const imported = importMap.get(dependencyName)

            if (imported !== undefined) {
                const importedKey = registryKey(imported.resolvedFileName, imported.importedName)

                if (registry.has(importedKey)) {
                    entry.dependencies.push(importedKey)
                    continue
                }
            }

            if (candidate.declarationHeritage && entry.requiredBaseName === undefined) {
                entry.requiredBaseName = dependencyName
            }
        }
    }

    return registry
}

type Candidate = {
    sourceFile           : ts.SourceFile,
    name                 : string,
    dependencyNames      : string[],
    requiredBaseName     : string | undefined,
    requiredBaseIsPackageBase : boolean,
    configProperties     : ConfigProperty[],
    declarationHeritage  : boolean,
    defaultExport        : boolean
}

// Program-wide map of ordinary (non-mixin) classes that transitively extend the
// package `Base`. Built once per program so a cross-file `extends`/required-base
// reference can be recognised as a construction base (and its accumulated config
// fields read) without re-analysing the defining file.
export function buildConstructionBaseRegistry(
    tsInstance: TypeScript,
    program: ts.Program,
    options: Partial<TransformOptions> = {},
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined
): ConstructionBaseRegistry {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    type ConstructionBaseCandidate = {
        fileName            : string,
        name                : string,
        baseName            : string | undefined,
        extendsPackageBase  : boolean,
        ownConfigProperties : ConfigProperty[],
        importMap           : Map<string, ImportedNameBinding>
    }

    const candidatesByKey = new Map<string, ConstructionBaseCandidate>()
    const candidates: ConstructionBaseCandidate[] = []

    for (const sourceFile of program.getSourceFiles()) {
        if (shouldSkipRegistrySourceFile(sourceFile) ||
            sourceFile.isDeclarationFile ||
            !sourceFile.text.includes(resolvedOptions.packageName)
        ) {
            continue
        }

        const facts = getSourceFileFacts(tsInstance, sourceFile, resolvedOptions)
        let importMap: Map<string, ImportedNameBinding> | undefined

        for (const classFacts of facts.classes) {
            if (classFacts.name === undefined ||
                classFacts.hasMixinDecorator ||
                classFacts.extendsType === undefined
            ) {
                continue
            }

            importMap ??= buildImportedNameMap(tsInstance, sourceFile, resolveModuleFileName, facts)

            const baseExpression = classFacts.extendsType.expression
            const candidate: ConstructionBaseCandidate = {
                fileName            : sourceFile.fileName,
                name                : classFacts.name,
                baseName            : tsInstance.isIdentifier(baseExpression) ? baseExpression.text : undefined,
                extendsPackageBase  : isPackageBaseExpression(tsInstance, baseExpression, resolvedOptions, facts),
                ownConfigProperties : classFacts.configProperties,
                importMap
            }

            candidates.push(candidate)
            candidatesByKey.set(registryKey(sourceFile.fileName, classFacts.name), candidate)
        }
    }

    const resolved = new Map<string, { isBaseDescendant: boolean, configProperties: ConfigProperty[] }>()

    const resolve = (
        candidate: ConstructionBaseCandidate,
        seen: Set<string>
    ): { isBaseDescendant: boolean, configProperties: ConfigProperty[] } => {
        const key = registryKey(candidate.fileName, candidate.name)
        const cached = resolved.get(key)

        if (cached !== undefined) {
            return cached
        }

        if (seen.has(key)) {
            return { isBaseDescendant : false, configProperties : candidate.ownConfigProperties }
        }

        seen.add(key)

        if (candidate.extendsPackageBase) {
            const result = { isBaseDescendant : true, configProperties : candidate.ownConfigProperties }

            resolved.set(key, result)

            return result
        }

        const baseCandidate = candidate.baseName === undefined
            ? undefined
            : candidatesByKey.get(registryKey(candidate.fileName, candidate.baseName)) ??
                resolveImportedConstructionBaseCandidate(candidate, candidatesByKey)

        if (baseCandidate === undefined) {
            const result = { isBaseDescendant : false, configProperties : candidate.ownConfigProperties }

            resolved.set(key, result)

            return result
        }

        const baseResolved = resolve(baseCandidate, seen)
        const result = {
            isBaseDescendant : baseResolved.isBaseDescendant,
            configProperties : uniqueConfigProperties([ ...baseResolved.configProperties, ...candidate.ownConfigProperties ])
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

        const imported = candidate.importMap.get(candidate.baseName)

        return imported === undefined
            ? undefined
            : byKey.get(registryKey(imported.resolvedFileName, imported.importedName))
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

    return registry
}

function cachedSourceFileMixinCandidates(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): Candidate[] {
    const cacheKey = registryCandidateCacheKey(sourceFile, options)
    const cached = registryCandidateCache.get(sourceFile)?.get(cacheKey)

    if (cached !== undefined) {
        return cached
    }

    const candidates = collectSourceFileMixinCandidates(tsInstance, sourceFile, options)
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
        return collectDeclarationFileMixinCandidates(tsInstance, sourceFile)
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
            name                 : classFacts.name,
            dependencyNames      : classFacts.implementsIdentifierNames,
            requiredBaseName     : classFacts.requiredBaseName,
            requiredBaseIsPackageBase : classFacts.extendsType !== undefined &&
                isPackageBaseExpression(tsInstance, classFacts.extendsType.expression, options, facts),
            configProperties     : classFacts.configProperties,
            declarationHeritage  : false,
            defaultExport        : classFacts.defaultExport
        })
    }

    return candidates
}

function registryCandidateCacheKey(sourceFile: ts.SourceFile, options: TransformOptions): string {
    return sourceFile.isDeclarationFile
        ? "declaration"
        : [ options.packageName, options.decoratorName ].join("|")
}

function shouldSkipRegistrySourceFile(sourceFile: ts.SourceFile): boolean {
    if (sourceFile.isDeclarationFile) {
        return !/\.[cm]?tsx?$/.test(normalizePath(sourceFile.fileName))
    }

    return shouldSkipFileName(sourceFile.fileName)
}

function collectDeclarationFileMixinCandidates(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Candidate[] {
    if (!sourceFile.text.includes(runtimeMixinClassName)) {
        return []
    }

    const candidates: Candidate[] = []
    const interfaces = new Map<string, ts.InterfaceDeclaration>()
    const defaultExportNames = new Set<string>()

    for (const statement of sourceFile.statements) {
        if (tsInstance.isInterfaceDeclaration(statement)) {
            interfaces.set(statement.name.text, statement)
            continue
        }

        if (tsInstance.isExportAssignment(statement) && tsInstance.isIdentifier(statement.expression)) {
            defaultExportNames.add(statement.expression.text)
        }
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isVariableStatement(statement)) {
            continue
        }

        const exportedStatement = hasModifier(tsInstance, statement, tsInstance.SyntaxKind.ExportKeyword)

        for (const declaration of statement.declarationList.declarations) {
            if (!tsInstance.isIdentifier(declaration.name) ||
                declaration.type === undefined ||
                !typeReferencesRuntimeMixinClass(tsInstance, declaration.type)
            ) {
                continue
            }

            const defaultExport = defaultExportNames.has(declaration.name.text)

            if (!exportedStatement && !defaultExport) {
                continue
            }

            candidates.push({
                sourceFile,
                name                 : declaration.name.text,
                dependencyNames      : interfaceExtendsNames(tsInstance, interfaces.get(declaration.name.text)),
                requiredBaseName     : undefined,
                requiredBaseIsPackageBase : false,
                configProperties     : interfaceConfigProperties(tsInstance, interfaces.get(declaration.name.text)),
                declarationHeritage  : true,
                defaultExport
            })
        }
    }

    return candidates
}

function typeReferencesRuntimeMixinClass(tsInstance: TypeScript, typeNode: ts.TypeNode): boolean {
    if (tsInstance.isTypeReferenceNode(typeNode) &&
        tsInstance.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === runtimeMixinClassName
    ) {
        return true
    }

    if (tsInstance.isIntersectionTypeNode(typeNode) || tsInstance.isUnionTypeNode(typeNode)) {
        return typeNode.types.some((type) => typeReferencesRuntimeMixinClass(tsInstance, type))
    }

    if (tsInstance.isParenthesizedTypeNode(typeNode)) {
        return typeReferencesRuntimeMixinClass(tsInstance, typeNode.type)
    }

    return false
}

function interfaceExtendsNames(
    tsInstance: TypeScript,
    declaration: ts.InterfaceDeclaration | undefined
): string[] {
    const clause = declaration?.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })

    if (clause === undefined) {
        return []
    }

    return clause.types
        .map((heritageType) => heritageType.expression)
        .filter((expression): expression is ts.Identifier => tsInstance.isIdentifier(expression))
        .map((expression) => expression.text)
}

function interfaceConfigProperties(
    tsInstance: TypeScript,
    declaration: ts.InterfaceDeclaration | undefined
): ConfigProperty[] {
    if (declaration === undefined) {
        return []
    }

    return uniqueConfigProperties(declaration.members
        .filter((member): member is ts.PropertySignature => {
            return tsInstance.isPropertySignature(member) && member.name !== undefined
        })
        .flatMap((member) => {
            const name = propertyNameText(tsInstance, member.name)

            return name === undefined
                ? []
                : [ {
                    name,
                    optional : member.questionToken !== undefined
                } ]
        })
    )
}

export function hasRuntimeModuleForDeclaration(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    fileName: string
): boolean {
    if (!fileName.endsWith(".d.ts") && !fileName.endsWith(".d.mts") && !fileName.endsWith(".d.cts")) {
        return true
    }

    return runtimeModuleFileNames(fileName).some((runtimeFileName) => {
        return compilerHost.fileExists(runtimeFileName) ||
            tsInstance.sys.fileExists(runtimeFileName)
    })
}

function runtimeModuleFileNames(declarationFileName: string): string[] {
    if (declarationFileName.endsWith(".d.mts")) {
        return [
            declarationFileName.slice(0, -".d.mts".length) + ".mjs",
            declarationFileName.slice(0, -".d.mts".length) + ".js"
        ]
    }

    if (declarationFileName.endsWith(".d.cts")) {
        return [
            declarationFileName.slice(0, -".d.cts".length) + ".cjs",
            declarationFileName.slice(0, -".d.cts".length) + ".js"
        ]
    }

    return [
        declarationFileName.slice(0, -".d.ts".length) + ".js",
        declarationFileName.slice(0, -".d.ts".length) + ".mjs",
        declarationFileName.slice(0, -".d.ts".length) + ".cjs"
    ]
}
