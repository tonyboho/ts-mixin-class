import type * as ts from "typescript"
import { type FileMixinContext, type TransformOptions } from "./model.js"
import {
    anyConstructorName,
    applyLegacyClassDecoratorsName,
    applyLegacyClassDecoratorsLocalName,
    classStaticsName,
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
    mixinFactoryName,
    runtimeMixinClassName,
    staticConflictKeysName
} from "./naming.js"
import type { SourceFileFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

// Import management of the transformed file: the generated helper-type / mixin-factory
// imports a transformed file needs are inserted after the last original import, pruned to
// the names the generated output actually references, and the consumed `@mixin` decorator
// imports are dropped — so the result never trips `noUnusedLocals` (TS6133).

// Every identifier referenced in `statements`, skipping import declarations (an imported
// name is a binding, not a use). A superset is harmless: it only ever keeps an import we
// could have pruned, never drops one that is needed.
export function collectReferencedIdentifierNames(
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
export function pruneConsumedDecoratorImports(
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

// Generated imports (type helpers + mixin factories from other modules) are
// inserted after the last original import.
export function insertGeneratedImports(
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
        { typeOnly: false, importedName: applyLegacyClassDecoratorsName, localName: applyLegacyClassDecoratorsLocalName },
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
