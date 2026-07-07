import type * as ts from "typescript"
import type { ImportMap } from "./model.js"
import type { SourceFileFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

// Unfiltered import maps are recomputed for the same file across the construction-base
// registry, the per-file mixin context, the base-import lookup, and the cross-file
// construction gate — all within one program, where the `resolveModuleFileName` closure
// is a stable identity. Memoize the unfiltered result per (resolveFn, sourceFile); the
// map is only ever read by callers, so sharing it is safe. The filtered variant (registry
// dependency pruning) is left uncached — it is already locally cached at its one caller.

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
    const importMap: ImportMap = new Map()

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

        if (namedBindings === undefined) {
            return
        }

        if (tsInstance.isNamespaceImport(namedBindings)) {
            importMap.set(namedBindings.name.text, {
                resolvedFileName,
                importedName : "*",
                typeOnly     : importClause?.isTypeOnly === true,
                namespace    : true
            })

            return
        }

        if (!tsInstance.isNamedImports(namedBindings)) {
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
            addImport(
                importFacts.declaration,
                importFacts.specifier,
                importFacts.localNames.length + (importFacts.namespaceName === undefined ? 0 : 1)
            )
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
            (namedBindings !== undefined && tsInstance.isNamespaceImport(namedBindings) ? 1 : 0) +
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

    // A namespace import matches when the filter holds the binding itself or any
    // QUALIFIED name through it (dotted dependency names like "lib.Logger").
    if (namedBindings !== undefined && tsInstance.isNamespaceImport(namedBindings)) {
        const namespaceName = namedBindings.name.text

        return localNameFilter.has(namespaceName) ||
            [ ...localNameFilter ].some((name) => name.startsWith(namespaceName + "."))
    }

    return namedBindings !== undefined &&
        tsInstance.isNamedImports(namedBindings) &&
        namedBindings.elements.some((element) => {
            return localNameFilter.has(element.name.text)
        })
}
