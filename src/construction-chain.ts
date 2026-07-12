import type * as ts from "typescript"

import { dottedExpressionText } from "./entity-name.js"
import {
    importedBindingRegistryKey,
    accumulateRegisteredMixinConfig,
    registeredMixinInventoryComplete,
    registryKey,
    transplantableConfigProperties,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionBaseEntry,
    type CrossFileContext,
    type ImportMap,
    type TransformOptions
} from "./model.js"
import { getSourceFileFacts, qualifiedLocalClassFacts, type ClassFacts, type SourceFileFacts } from "./source-file-facts.js"
import type { TypeScript } from "./util.js"

// Walking construction heritage CHAINS: the `extends Base` opt-in recognizer (local,
// qualified-local-namespace, namespace-import and cross-file-registry forms), the
// qualified-chain exit used at registry collection time, and the recursive accumulation
// of the `.new(...)` config properties a chain contributes (base classes up to `Base`,
// plus every mixin consumed along the way, with generic type parameters substituted).
// The AST-factory side (the generated `static new` + `<Name>Config` alias) stays in
// `construction-config.ts`.

export function isConstructionBaseOptIn(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    options: TransformOptions,
    facts = getSourceFileFacts(tsInstance, sourceFile, options),
    seen = new Set<string>(),
    crossFile?: CrossFileContext,
    baseImportMap?: ImportMap
): boolean {
    if (baseType === undefined) {
        return false
    }

    if (isPackageBaseExpression(tsInstance, baseType.expression, options, facts)) {
        return true
    }

    // A QUALIFIED base (`data.Model`) resolves through the local-namespace index; the
    // dotted text keys the `seen` set (disjoint from plain identifiers, which never
    // contain a dot). When the dotted name is not a local namespace path, it may be a
    // NAMESPACE-IMPORT member (`lib.Model`), resolved through the cross-file registry.
    // (`isPackageBaseExpression` above already accepted the package `ns.Base` form.)
    if (!tsInstance.isIdentifier(baseType.expression)) {
        const dottedName = dottedExpressionText(tsInstance, baseType.expression)

        if (dottedName === undefined || seen.has(dottedName)) {
            return false
        }

        seen.add(dottedName)

        const qualifiedBase = qualifiedLocalClassFacts(tsInstance, sourceFile, baseType.expression, facts)

        if (qualifiedBase === undefined) {
            return resolveCrossFileConstructionBase(dottedName, crossFile, baseImportMap)?.isBaseDescendant === true
        }

        return isConstructionBaseOptIn(
            tsInstance,
            sourceFile,
            qualifiedBase.extendsType,
            options,
            facts,
            seen,
            crossFile,
            baseImportMap
        )
    }

    const baseName = baseType.expression.text

    if (seen.has(baseName)) {
        return false
    }

    seen.add(baseName)

    const localBase = facts.classesByName.get(baseName)

    if (localBase !== undefined) {
        return isConstructionBaseOptIn(
            tsInstance,
            sourceFile,
            localBase.extendsType,
            options,
            facts,
            seen,
            crossFile,
            baseImportMap
        )
    }

    // The base is not declared in this file: it may be an imported class that
    // transitively extends the package `Base`, recorded in the cross-file
    // construction-base registry.
    return resolveCrossFileConstructionBase(baseName, crossFile, baseImportMap)?.isBaseDescendant === true
}

// Resolves a local base identifier to its cross-file construction-base entry,
// when the name is imported and the imported class transitively extends `Base`.
// A DOTTED name (`lib.Model`) resolves through its namespace-import binding —
// exactly one dot: registry entries are top-level classes of their module, so a
// deeper path can never name one.
export function resolveCrossFileConstructionBase(
    name: string,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined
): ConstructionBaseEntry | undefined {
    if (crossFile === undefined || baseImportMap === undefined) {
        return undefined
    }

    const key = importedBindingRegistryKey(name, baseImportMap)

    return key === undefined ? undefined : crossFile.constructionBases.get(key)
}

export function isPackageBaseExpression(
    tsInstance: TypeScript,
    expression: ts.Expression,
    options: TransformOptions,
    facts: SourceFileFacts
): boolean {
    for (const importFacts of facts.imports) {
        if (!isPackageBaseImport(importFacts.specifier, options)) {
            continue
        }

        const importClause  = importFacts.declaration.importClause
        const namedBindings = importClause?.namedBindings

        if (namedBindings === undefined) {
            continue
        }

        if (tsInstance.isNamespaceImport(namedBindings) &&
            tsInstance.isPropertyAccessExpression(expression) &&
            tsInstance.isIdentifier(expression.expression) &&
            expression.expression.text === namedBindings.name.text &&
            expression.name.text === "Base"
        ) {
            return true
        }

        if (!tsInstance.isNamedImports(namedBindings) || !tsInstance.isIdentifier(expression)) {
            continue
        }

        if (namedBindings.elements.some((element) => {
            return (element.propertyName?.text ?? element.name.text) === "Base" &&
                element.name.text === expression.text
        })) {
            return true
        }
    }

    return false
}

function isPackageBaseImport(
    specifier: string,
    options: TransformOptions
): boolean {
    return specifier === options.packageName || specifier === `${options.packageName}/base`
}

// Construction-base opt-in can only ever resolve to true when the file itself
// imports the package `Base` (the `isConstructionBaseOptIn` chain terminates at
// `isPackageBaseExpression`, which requires a local package-base import). The
// transform gate uses this as a cheap pre-check so files that merely extend some
// ordinary class are not cloned and walked in source-view mode.
export function importsPackageBase(
    tsInstance: TypeScript,
    facts: SourceFileFacts,
    options: TransformOptions
): boolean {
    for (const importFacts of facts.imports) {
        if (!isPackageBaseImport(importFacts.specifier, options)) {
            continue
        }

        const namedBindings = importFacts.declaration.importClause?.namedBindings

        if (namedBindings === undefined) {
            continue
        }

        if (tsInstance.isNamespaceImport(namedBindings)) {
            return true
        }

        if (namedBindings.elements.some((element) => {
            return (element.propertyName?.text ?? element.name.text) === "Base"
        })) {
            return true
        }
    }

    return false
}

// How a QUALIFIED base's locally-resolvable extends chain leaves the file. The
// construction-base registry resolves a candidate's qualified base with this walk: the
// chain either reaches the package `Base` import (`isPackageBase`), or exits at a
// reference no local class declares — an imported identifier, or a namespace-import
// member when the qualified path itself is not local — whose name (`unresolvedName`)
// the registry chases through its ordinary imported-candidate resolution.
// `configProperties` carries what the LOCAL levels of the chain contribute (their own
// fields, local extends levels and local mixins); the imported tail's contribution is
// added by the caller's own resolution. Returns undefined when the chain dead-ends
// locally (no `extends`, a cycle, or an unresolvable dotted path).
export type QualifiedBaseChainExit = {
    isPackageBase     : boolean,
    unresolvedName    : string | undefined,
    configProperties  : ConfigProperty[],
    // Whether `configProperties` provably lists the local levels' WHOLE contribution.
    // Collection time has no cross-file context to judge `implements` targets by, so
    // this is conservative: any `implements` or index signature on a visited level
    // answers false (see `chainInventoryComplete` for the full-context walk).
    inventoryComplete : boolean
}

export function qualifiedConstructionChainExit(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments,
    options: TransformOptions,
    facts: SourceFileFacts
): QualifiedBaseChainExit | undefined {
    const dottedName = dottedExpressionText(tsInstance, baseType.expression)

    if (dottedName === undefined) {
        return undefined
    }

    const firstLocal = qualifiedLocalClassFacts(tsInstance, sourceFile, baseType.expression, facts)

    // Not a local namespace path — a namespace-import member; nothing local to fold in.
    if (firstLocal === undefined) {
        return { isPackageBase: false, unresolvedName: dottedName, configProperties: [], inventoryComplete: true }
    }

    const seen            = new Set<string>([ dottedName ])
    let current           = firstLocal
    let inventoryComplete = true
    let exit: { isPackageBase: boolean, unresolvedName: string | undefined }

    for (;;) {
        inventoryComplete = inventoryComplete &&
            current.indexSignatures.length === 0 &&
            current.implementsIdentifierNames.length === 0 &&
            current.implementsQualifiedNames.length === 0

        const currentBase = current.extendsType

        if (currentBase === undefined) {
            return undefined
        }

        if (isPackageBaseExpression(tsInstance, currentBase.expression, options, facts)) {
            exit = { isPackageBase: true, unresolvedName: undefined }
            break
        }

        const key = tsInstance.isIdentifier(currentBase.expression)
            ? currentBase.expression.text
            : dottedExpressionText(tsInstance, currentBase.expression)

        if (key === undefined || seen.has(key)) {
            return undefined
        }

        seen.add(key)

        const next = tsInstance.isIdentifier(currentBase.expression)
            ? facts.classesByName.get(key)
            : qualifiedLocalClassFacts(tsInstance, sourceFile, currentBase.expression, facts)

        if (next === undefined) {
            exit = { isPackageBase: false, unresolvedName: key }
            break
        }

        current = next
    }

    return {
        ...exit,
        inventoryComplete,
        configProperties : localClassConfigProperties(
            tsInstance,
            sourceFile,
            firstLocal,
            facts,
            undefined,
            undefined,
            new Set()
        )
    }
}

// Accumulates the full construction config a base contributes to a subclass's
// `.new(...)`: the base's own public fields, those inherited up its own `extends`
// chain, and those of every mixin it consumes - recursively. A local base may itself
// be a construction consumer (it extends another construction base and/or implements
// mixins), so reading only its own fields drops inherited config and breaks the
// static-side `new` along the chain (TS2417). Imported bases are read from the
// cross-file registry, which carries the accumulated extends-chain config.
export function baseConfigProperties(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    if (baseType === undefined) {
        return []
    }

    // A QUALIFIED base contributes its accumulated config through the local-namespace
    // index, keyed in `seen` by its dotted text (same convention as the opt-in walk);
    // a NAMESPACE-IMPORT member (`lib.Model`) reads its accumulated config from the
    // cross-file registry entry instead.
    if (!tsInstance.isIdentifier(baseType.expression)) {
        const dottedName = dottedExpressionText(tsInstance, baseType.expression)

        if (dottedName === undefined || seen.has(dottedName)) {
            return []
        }

        seen.add(dottedName)

        const qualifiedBase = qualifiedLocalClassFacts(tsInstance, sourceFile, baseType.expression, facts)

        if (qualifiedBase === undefined) {
            // Cross-file config: computed keys reference module-scoped consts/symbols of
            // the DECLARING file and cannot be spelled here — strip them.
            return transplantableConfigProperties(
                resolveCrossFileConstructionBase(dottedName, crossFile, baseImportMap)?.configProperties ?? []
            )
        }

        return localClassConfigProperties(tsInstance, sourceFile, qualifiedBase, facts, crossFile, baseImportMap, seen)
    }

    return configPropertiesForName(tsInstance, sourceFile, baseType.expression.text, facts, crossFile, baseImportMap, seen)
}

function localClassConfigProperties(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    localClass: ClassFacts,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    // NEAREST-first (the `uniqueConfigProperties` contract): own members, then the
    // consumed mixins in listed (nearest) order, then the extends chain.
    return uniqueConfigProperties([
        ...localClass.configProperties,
        ...localClass.implementsIdentifierNames.flatMap((implemented) =>
            configPropertiesForName(tsInstance, sourceFile, implemented, facts, crossFile, baseImportMap, seen)),
        ...baseConfigProperties(tsInstance, sourceFile, localClass.extendsType, facts, crossFile, baseImportMap, seen)
    ])
}

function configPropertiesForName(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    name: string,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    if (seen.has(name)) {
        return []
    }

    seen.add(name)

    const localClass = facts.classesByName.get(name)

    if (localClass !== undefined) {
        return localClassConfigProperties(tsInstance, sourceFile, localClass, facts, crossFile, baseImportMap, seen)
    }

    // Not declared in this file: an imported construction base (its accumulated
    // extends-chain config lives in the cross-file registry) or an imported mixin
    // (its own plus dependency config lives in the mixin registry).
    const baseEntry = resolveCrossFileConstructionBase(name, crossFile, baseImportMap)

    if (baseEntry !== undefined) {
        // Computed keys cannot be spelled outside their declaring file.
        return transplantableConfigProperties(baseEntry.configProperties)
    }

    return transplantableConfigProperties(importedMixinConfigProperties(name, crossFile, baseImportMap, seen))
}

function importedMixinConfigProperties(
    name: string,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    const imported = baseImportMap?.get(name)

    if (imported === undefined || crossFile === undefined) {
        return []
    }

    return accumulateRegisteredMixinConfig(
        registryKey(imported.resolvedFileName, imported.importedName),
        crossFile.registry,
        seen
    )
}

// The completeness twin of `baseConfigProperties`: whether the chain's accumulated list
// is provably its WHOLE config contribution — no index signatures at any level, nothing
// lost to the cross-file computed-key strip, every cross-file exit's registry entry
// itself complete. Only a complete-AND-EMPTY chain lets the composition skip the
// parent's alias reference: an empty class's alias is the exact-empty idiom (§7.25),
// whose never-typed index signatures would poison every other layer in the flatten. A
// name the property walk cannot resolve contributes nothing there (an interface in an
// `implements` slot, the package `Base` itself), so it answers complete here — mirroring
// what the walk counted, not what the unreadable target might hold.
export function chainInventoryComplete(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): boolean {
    if (baseType === undefined) {
        return true
    }

    if (!tsInstance.isIdentifier(baseType.expression)) {
        const dottedName = dottedExpressionText(tsInstance, baseType.expression)

        if (dottedName === undefined || seen.has(dottedName)) {
            return dottedName !== undefined
        }

        seen.add(dottedName)

        const qualifiedBase = qualifiedLocalClassFacts(tsInstance, sourceFile, baseType.expression, facts)

        if (qualifiedBase === undefined) {
            return crossFileBaseEntryInventoryComplete(
                resolveCrossFileConstructionBase(dottedName, crossFile, baseImportMap)
            )
        }

        return localClassInventoryComplete(tsInstance, sourceFile, qualifiedBase, facts, crossFile, baseImportMap, seen)
    }

    return inventoryCompleteForName(tsInstance, sourceFile, baseType.expression.text, facts, crossFile, baseImportMap, seen)
}

function localClassInventoryComplete(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    localClass: ClassFacts,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): boolean {
    // Qualified `implements` names are not folded by `localClassConfigProperties` at all,
    // so a class carrying one cannot prove its accumulated list complete.
    return localClass.indexSignatures.length === 0 &&
        localClass.implementsQualifiedNames.length === 0 &&
        localClass.implementsIdentifierNames.every((implemented) =>
            inventoryCompleteForName(tsInstance, sourceFile, implemented, facts, crossFile, baseImportMap, seen)) &&
        chainInventoryComplete(tsInstance, sourceFile, localClass.extendsType, facts, crossFile, baseImportMap, seen)
}

function inventoryCompleteForName(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    name: string,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): boolean {
    if (seen.has(name)) {
        return true
    }

    seen.add(name)

    const localClass = facts.classesByName.get(name)

    if (localClass !== undefined) {
        return localClassInventoryComplete(tsInstance, sourceFile, localClass, facts, crossFile, baseImportMap, seen)
    }

    const baseEntry = resolveCrossFileConstructionBase(name, crossFile, baseImportMap)

    if (baseEntry !== undefined) {
        return crossFileBaseEntryInventoryComplete(baseEntry)
    }

    const imported = baseImportMap?.get(name)

    if (imported !== undefined && crossFile !== undefined) {
        const key = registryKey(imported.resolvedFileName, imported.importedName)

        // An imported name outside both registries contributes nothing to the property
        // walk (an interface, or the package `Base` itself) — complete by mirroring.
        return crossFile.registry.has(key)
            ? registeredMixinInventoryComplete(key, crossFile.registry, seen)
            : true
    }

    return true
}

function crossFileBaseEntryInventoryComplete(baseEntry: ConstructionBaseEntry | undefined): boolean {
    return baseEntry !== undefined &&
        baseEntry.configInventoryComplete === true &&
        // The property walk strips computed keys cross-file — a stripped key is a key the
        // accumulated list no longer shows, so the list cannot prove emptiness.
        transplantableConfigProperties(baseEntry.configProperties).length === baseEntry.configProperties.length
}
