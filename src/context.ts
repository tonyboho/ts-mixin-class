import path from "node:path"
import type * as ts from "typescript"
import {
    generatedName,
    mixinFactorySuffix,
    mixinValueSuffix,
    normalizePath,
    registryKey,
    type CrossFileContext,
    type FileMixinContext,
    type ImportedNameBinding,
    type MixinDecoratorImports,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

export function buildImportedNameMap(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined,
    facts?: SourceFileFacts,
    localNameFilter?: ReadonlySet<string>
): Map<string, ImportedNameBinding> {
    const importMap = new Map<string, ImportedNameBinding>()

    if (resolveModuleFileName === undefined) {
        return importMap
    }

    const addImport = (statement: ts.ImportDeclaration, specifier: string, localNamesLength: number): void => {
        if (localNamesLength === 0) {
            return
        }

        if (localNameFilter !== undefined && !importHasFilteredLocalName(tsInstance, statement, localNameFilter)) {
            return
        }

        const importClause = statement.importClause
        const namedBindings = importClause?.namedBindings

        const resolvedFileName = resolveModuleFileName(specifier, sourceFile.fileName)

        if (resolvedFileName === undefined) {
            return
        }

        if (importClause?.name !== undefined) {
            importMap.set(importClause.name.text, {
                resolvedFileName,
                importedName : "default",
                typeOnly     : importClause.isTypeOnly
            })
        }

        if (namedBindings === undefined || !tsInstance.isNamedImports(namedBindings)) {
            return
        }

        for (const element of namedBindings.elements) {
            importMap.set(element.name.text, {
                resolvedFileName,
                importedName : element.propertyName?.text ?? element.name.text,
                typeOnly     : importClause?.isTypeOnly === true || element.isTypeOnly
            })
        }
    }

    if (facts !== undefined) {
        for (const importFacts of facts.imports) {
            addImport(importFacts.declaration, importFacts.specifier, importFacts.localNames.length)
        }

        return importMap
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isImportDeclaration(statement) ||
            !tsInstance.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue
        }

        const importClause = statement.importClause
        const namedBindings = importClause?.namedBindings
        const localNamesLength = (importClause?.name === undefined ? 0 : 1) +
            (namedBindings !== undefined && tsInstance.isNamedImports(namedBindings) ? namedBindings.elements.length : 0)

        addImport(statement, statement.moduleSpecifier.text, localNamesLength)
    }

    return importMap
}

function importHasFilteredLocalName(
    tsInstance: TypeScript,
    statement: ts.ImportDeclaration,
    localNameFilter: ReadonlySet<string>
): boolean {
    const importClause = statement.importClause
    const namedBindings = importClause?.namedBindings

    if (importClause?.name !== undefined && localNameFilter.has(importClause.name.text)) {
        return true
    }

    return namedBindings !== undefined &&
        tsInstance.isNamedImports(namedBindings) &&
        namedBindings.elements.some((element) => {
            return localNameFilter.has(element.name.text)
        })
}

function importedRequiredBaseRef(
    importMap: Map<string, ImportedNameBinding>,
    resolvedFileName: string,
    specifier: string,
    importedName: string,
    fallbackLocalName: string
): ResolvedMixinRef["requiredBase"] {
    for (const [ localName, imported ] of importMap) {
        if (imported.resolvedFileName === resolvedFileName && imported.importedName === importedName) {
            return {
                localName,
                import : undefined
            }
        }
    }

    return {
        localName : fallbackLocalName,
        import    : {
            specifier,
            importedName,
            localName : fallbackLocalName
        }
    }
}

export function buildFileMixinContext(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    options: TransformOptions,
    crossFile?: CrossFileContext,
    facts = getSourceFileFacts(tsInstance, sourceFile, options)
): FileMixinContext {
    const context: FileMixinContext = {
        byLocalName        : new Map(),
        byKey              : new Map(),
        usedFactoryImports : new Map(),
        // Share the program-wide linearization index when cross-file context is
        // available; otherwise fall back to a file-local cache (still reused
        // across multiple consumers in the same file).
        linearizationCache : crossFile?.linearizationCache ?? new Map()
    }

    addLocalMixinRefs(sourceFile, imports, facts, context)

    if (crossFile !== undefined) {
        addImportedMixinRefs(tsInstance, sourceFile, crossFile, facts, context)
    }

    addSameFileDependencies(facts, context)

    if (crossFile !== undefined) {
        addTransitiveRegistryClosure(sourceFile, crossFile, context)
    }

    return context
}

function addLocalMixinRefs(
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    facts: SourceFileFacts,
    context: FileMixinContext
): void {
    if (imports.identifiers.size > 0 || imports.namespaces.size > 0) {
        for (const classFacts of facts.classes) {
            if (!classFacts.hasMixinDecorator || classFacts.name === undefined) {
                continue
            }

            const name = classFacts.name
            const ref: ResolvedMixinRef = {
                key              : registryKey(sourceFile.fileName, name),
                className        : name,
                localValueName   : name,
                localFactoryName : generatedName(name, mixinFactorySuffix),
                factoryImport    : undefined,
                requiredBase     : undefined,
                dependencies     : [],
                declaration      : classFacts.declaration,
                configProperties : classFacts.configProperties,
                missingRuntimeImport : undefined
            }

            context.byLocalName.set(name, ref)
            context.byKey.set(ref.key, ref)
        }
    }
}

function addImportedMixinRefs(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    crossFile: CrossFileContext,
    facts: SourceFileFacts,
    context: FileMixinContext
): void {
    const importMap = buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName, facts)

    for (const importFacts of facts.imports) {
        if (importFacts.localNames.length === 0) {
            continue
        }

        for (const localName of importFacts.localNames) {
            const imported  = importMap.get(localName)

            if (imported === undefined || context.byLocalName.has(localName)) {
                continue
            }

            const key        = registryKey(imported.resolvedFileName, imported.importedName)
            const registered = crossFile.registry.get(key)

            if (registered === undefined) {
                continue
            }

            const localValueName = imported.typeOnly ? generatedName(localName, mixinValueSuffix) : localName

            if (imported.typeOnly) {
                const importedValueName = registered.defaultExport ? "default" : registered.name

                context.usedFactoryImports.set(
                    `${importFacts.specifier}:${importedValueName}:${localValueName}`,
                    {
                        specifier    : importFacts.specifier,
                        importedName : importedValueName,
                        localName    : localValueName
                    }
                )
            }

            const requiredBase = registered.requiredBaseName === undefined
                ? undefined
                : importedRequiredBaseRef(
                    importMap,
                    imported.resolvedFileName,
                    importFacts.specifier,
                    registered.requiredBaseName,
                    localName + "$requiredBase"
                )

            const ref: ResolvedMixinRef = {
                key,
                className        : registered.name,
                localValueName,
                localFactoryName : generatedName(localName, mixinFactorySuffix),
                factoryImport    : {
                    specifier    : importFacts.specifier,
                    importedName : generatedName(registered.name, mixinFactorySuffix)
                },
                requiredBase,
                dependencies     : registered.dependencies,
                declaration      : undefined,
                configProperties : registered.configProperties,
                missingRuntimeImport : crossFile.canImportRuntimeValue?.(registered.fileName) === false
                    ? {
                        specifier    : importFacts.specifier,
                        importedName : registered.defaultExport ? "default" : registered.name
                    }
                    : undefined
            }

            context.byLocalName.set(localName, ref)
            context.byKey.set(key, ref)
        }
    }
}

function addSameFileDependencies(
    facts: SourceFileFacts,
    context: FileMixinContext
): void {
    for (const ref of context.byLocalName.values()) {
        if (ref.declaration === undefined) {
            continue
        }

        const classFacts = facts.classesByDeclaration.get(ref.declaration)

        if (classFacts === undefined) {
            continue
        }

        for (const dependencyName of classFacts.implementsIdentifierNames) {
            const dependency = context.byLocalName.get(dependencyName)

            if (dependency !== undefined) {
                ref.dependencies.push(dependency.key)
            }
        }
    }
}

function addTransitiveRegistryClosure(
    sourceFile: ts.SourceFile,
    crossFile: CrossFileContext,
    context: FileMixinContext
): void {
    const queue = [ ...context.byKey.values() ].flatMap((ref) => ref.dependencies)

    while (queue.length > 0) {
        const key = queue.pop()

        if (key === undefined || context.byKey.has(key)) {
            continue
        }

        const registered = crossFile.registry.get(key)

        if (registered === undefined) {
            continue
        }

        const specifier = relativeImportSpecifier(sourceFile.fileName, registered.fileName)

        context.byKey.set(key, {
            key,
            className        : registered.name,
            localValueName   : undefined,
            localFactoryName : generatedName(registered.name, mixinFactorySuffix),
            factoryImport    : {
                specifier,
                importedName : generatedName(registered.name, mixinFactorySuffix)
            },
            requiredBase     : registered.requiredBaseName === undefined
                ? undefined
                : {
                    localName : registered.name + "$requiredBase",
                    import    : {
                        specifier,
                        importedName : registered.requiredBaseName,
                        localName    : registered.name + "$requiredBase"
                    }
            },
            dependencies     : registered.dependencies,
            declaration      : undefined,
            configProperties : registered.configProperties,
            missingRuntimeImport : crossFile.canImportRuntimeValue?.(registered.fileName) === false
                ? {
                    specifier,
                    importedName : registered.defaultExport ? "default" : registered.name
                }
                : undefined
        })

        queue.push(...registered.dependencies)
    }
}

export function relativeImportSpecifier(fromFileName: string, toFileName: string): string {
    const relative = path.posix.relative(
        path.posix.dirname(normalizePath(fromFileName)),
        normalizePath(toFileName)
    )

    const withoutExtension = relative
        .replace(/\.[cm]?tsx?$/, "")

    return withoutExtension.startsWith(".") ? withoutExtension : "./" + withoutExtension
}
