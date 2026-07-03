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
    type NativeMixinDiagnostic,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { getSourceFileFacts, type ClassFacts, type SourceFileFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

// Unfiltered import maps are recomputed for the same file across the construction-base
// registry, the per-file mixin context, the base-import lookup, and the cross-file
// construction gate — all within one program, where the `resolveModuleFileName` closure
// is a stable identity. Memoize the unfiltered result per (resolveFn, sourceFile); the
// map is only ever read by callers, so sharing it is safe. The filtered variant (registry
// dependency pruning) is left uncached — it is already locally cached at its one caller.
type ImportMap = Map<string, ImportedNameBinding>

const importedNameMapCache = new WeakMap<
    (specifier: string, containingFile: string) => string | undefined,
    WeakMap<ts.SourceFile, ImportMap>
>()

export function buildImportedNameMap(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    resolveModuleFileName?: (specifier: string, containingFile: string) => string | undefined,
    facts?: SourceFileFacts,
    localNameFilter?: ReadonlySet<string>
): ImportMap {
    const importMap = new Map<string, ImportedNameBinding>()

    if (resolveModuleFileName === undefined) {
        return importMap
    }

    const cacheable = localNameFilter === undefined

    if (cacheable) {
        const cached = importedNameMapCache.get(resolveModuleFileName)?.get(sourceFile)

        if (cached !== undefined) {
            return cached
        }
    }

    const addImport = (statement: ts.ImportDeclaration, specifier: string, localNamesLength: number): void => {
        if (localNamesLength === 0) {
            return
        }

        if (localNameFilter !== undefined && !importHasFilteredLocalName(tsInstance, statement, localNameFilter)) {
            return
        }

        const importClause  = statement.importClause
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

    const finish = (): ImportMap => {
        if (cacheable) {
            const byFile = importedNameMapCache.get(resolveModuleFileName) ?? new WeakMap<ts.SourceFile, ImportMap>()

            byFile.set(sourceFile, importMap)
            importedNameMapCache.set(resolveModuleFileName, byFile)
        }

        return importMap
    }

    if (facts !== undefined) {
        for (const importFacts of facts.imports) {
            addImport(importFacts.declaration, importFacts.specifier, importFacts.localNames.length)
        }

        return finish()
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isImportDeclaration(statement) ||
            !tsInstance.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue
        }

        const importClause     = statement.importClause
        const namedBindings    = importClause?.namedBindings
        const localNamesLength = (importClause?.name === undefined ? 0 : 1) +
            (namedBindings !== undefined && tsInstance.isNamedImports(namedBindings) ? namedBindings.elements.length : 0)

        addImport(statement, statement.moduleSpecifier.text, localNamesLength)
    }

    return finish()
}

function importHasFilteredLocalName(
    tsInstance: TypeScript,
    statement: ts.ImportDeclaration,
    localNameFilter: ReadonlySet<string>
): boolean {
    const importClause  = statement.importClause
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
    fallbackLocalName: string,
    requiredBaseIsPackageBase: boolean,
    packageName: string
): ResolvedMixinRef["requiredBase"] {
    // A mixin whose required base is the package `Base` carries it from the
    // package, not from the mixin's own module (which does not re-export `Base`).
    if (requiredBaseIsPackageBase) {
        return packageBaseRequiredBaseRef(packageName, fallbackLocalName)
    }

    for (const [ localName, imported ] of importMap) {
        if (imported.resolvedFileName === resolvedFileName && imported.importedName === importedName) {
            return {
                localName,
                import        : undefined,
                isPackageBase : false
            }
        }
    }

    return {
        localName : fallbackLocalName,
        import    : {
            specifier,
            importedName,
            localName : fallbackLocalName
        },
        isPackageBase : false
    }
}

function packageBaseRequiredBaseRef(
    packageName: string,
    localName: string
): NonNullable<ResolvedMixinRef["requiredBase"]> {
    return {
        localName,
        import : {
            specifier    : `${packageName}/base`,
            importedName : "Base",
            localName
        },
        isPackageBase : true
    }
}

export function buildFileMixinContext(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    options: TransformOptions,
    crossFile?: CrossFileContext,
    facts = getSourceFileFacts(tsInstance, sourceFile, options),
    nativeDiagnostics: NativeMixinDiagnostic[] = []
): FileMixinContext {
    const context: FileMixinContext = {
        sourceFile,
        hasNestedClasses   : facts.hasNestedClasses,
        byLocalName        : new Map(),
        byKey              : new Map(),
        byDeclaration      : new Map(),
        usedFactoryImports : new Map(),
        crossFile,
        // Share the program-wide linearization index when cross-file context is
        // available; otherwise fall back to a file-local cache (still reused
        // across multiple consumers in the same file).
        linearizationCache : crossFile?.linearizationCache ?? new Map(),
        nativeDiagnostics
    }

    addLocalMixinRefs(sourceFile, imports, facts, context)

    if (crossFile !== undefined) {
        addImportedMixinRefs(tsInstance, sourceFile, crossFile, facts, context, options)
    }

    addSameFileDependencies(facts, context)

    if (crossFile !== undefined) {
        addTransitiveRegistryClosure(sourceFile, crossFile, context, options)
    }

    return context
}

function addLocalMixinRefs(
    sourceFile: ts.SourceFile,
    imports: MixinDecoratorImports,
    facts: SourceFileFacts,
    context: FileMixinContext
): void {
    if (imports.identifiers.size === 0 && imports.namespaces.size === 0) {
        return
    }

    const register = (classFacts: ClassFacts): void => {
        if (!classFacts.hasMixinDecorator || classFacts.name === undefined) {
            return
        }

        const name                  = classFacts.name
        const ref: ResolvedMixinRef = {
            key                  : registryKey(sourceFile.fileName, name),
            className            : name,
            localValueName       : name,
            localFactoryName     : generatedName(name, mixinFactorySuffix),
            factoryImport        : undefined,
            requiredBase         : undefined,
            dependencies         : [],
            declaration          : classFacts.declaration,
            configProperties     : classFacts.configProperties,
            missingRuntimeImport : undefined
        }

        // Always keyed by its own declaration, so a nested mixin is detected and expanded from
        // ITS node even when a same-named mixin already claimed `byLocalName` / `byKey` (which
        // stay first-name-wins, since a same-file by-name reference can only resolve one).
        context.byDeclaration.set(classFacts.declaration, ref)

        if (!context.byLocalName.has(name)) {
            context.byLocalName.set(name, ref)
            context.byKey.set(ref.key, ref)
        }
    }

    for (const classFacts of facts.classes) {
        register(classFacts)
    }

    // Nested `@mixin` declarations (inside a function body / block) are indexed by declaration
    // only — not in `facts.classes` — so register them here too, making a nested mixin usable
    // within its own scope. A name already taken by a top-level mixin wins (the `has` guard);
    // scope-precise resolution for same-named nested mixins is a separate concern.
    if (facts.hasNestedClasses) {
        const topLevel = new Set(facts.classes.map((classFacts) => classFacts.declaration))

        for (const classFacts of facts.classesByDeclaration.values()) {
            if (!topLevel.has(classFacts.declaration)) {
                register(classFacts)
            }
        }
    }
}

function addImportedMixinRefs(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    crossFile: CrossFileContext,
    facts: SourceFileFacts,
    context: FileMixinContext,
    options: TransformOptions
): void {
    const importMap = buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName, facts)

    for (const importFacts of facts.imports) {
        if (importFacts.localNames.length === 0) {
            continue
        }

        for (const localName of importFacts.localNames) {
            const imported = importMap.get(localName)

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
                    localName + "$requiredBase",
                    registered.requiredBaseIsPackageBase,
                    options.packageName
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
                dependencies         : registered.dependencies,
                declaration          : undefined,
                configProperties     : registered.configProperties,
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
    context: FileMixinContext,
    options: TransformOptions
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
            requiredBase : registered.requiredBaseName === undefined
                ? undefined
                : registered.requiredBaseIsPackageBase
                    ? packageBaseRequiredBaseRef(options.packageName, registered.name + "$requiredBase")
                    : {
                        localName : registered.name + "$requiredBase",
                        import    : {
                            specifier,
                            importedName : registered.requiredBaseName,
                            localName    : registered.name + "$requiredBase"
                        },
                        isPackageBase : false
                    },
            dependencies         : registered.dependencies,
            declaration          : undefined,
            configProperties     : registered.configProperties,
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
