import type * as ts from "typescript"
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
    configProperties     : ConfigProperty[],
    declarationHeritage  : boolean,
    defaultExport        : boolean
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
