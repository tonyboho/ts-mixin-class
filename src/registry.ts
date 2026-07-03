import type * as ts from "typescript"
import { isPackageBaseExpression } from "./construction-config.js"
import { buildImportedNameMap } from "./context.js"
import {
    accumulateRegisteredMixinConfig,
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

    const importMaps            = new Map<string, Map<string, ImportedNameBinding>>()
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
        importMap: Map<string, ImportedNameBinding>
    ): string[] => {
        const separator = dependencyName.indexOf(".")

        if (separator >= 0) {
            if (dependencyName.indexOf(".", separator + 1) >= 0) {
                return []
            }

            const binding = importMap.get(dependencyName.slice(0, separator))

            return binding?.namespace === true
                ? [ registryKey(binding.resolvedFileName, dependencyName.slice(separator + 1)) ]
                : []
        }

        const keys     = [ registryKey(fileName, dependencyName) ]
        const imported = importMap.get(dependencyName)

        if (imported !== undefined) {
            keys.push(registryKey(imported.resolvedFileName, imported.importedName))
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

type Candidate = {
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
        fileName             : string,
        name                 : string,
        baseName             : string | undefined,
        extendsPackageBase   : boolean,
        ownConfigProperties  : ConfigProperty[],
        mixinDependencyNames : string[],
        importMap            : Map<string, ImportedNameBinding>
    }

    const candidatesByKey                         = new Map<string, ConstructionBaseCandidate>()
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

            // eslint-disable-next-line align-assignments/align-assignments
            importMap ??= buildImportedNameMap(tsInstance, sourceFile, resolveModuleFileName, facts)

            const baseExpression                       = classFacts.extendsType.expression
            const candidate: ConstructionBaseCandidate = {
                fileName             : sourceFile.fileName,
                name                 : classFacts.name,
                baseName             : tsInstance.isIdentifier(baseExpression) ? baseExpression.text : undefined,
                extendsPackageBase   : isPackageBaseExpression(tsInstance, baseExpression, resolvedOptions, facts),
                ownConfigProperties  : classFacts.configProperties,
                mixinDependencyNames : [
                    ...classFacts.implementsIdentifierNames,
                    ...classFacts.implementsQualifiedNames
                ],
                importMap
            }

            candidates.push(candidate)
            candidatesByKey.set(registryKey(sourceFile.fileName, classFacts.name), candidate)
        }
    }

    const resolved = new Map<string, { isBaseDescendant: boolean, configProperties: ConfigProperty[] }>()

    const candidateMixinConfig = (candidate: ConstructionBaseCandidate): ConfigProperty[] => {
        if (mixinRegistry === undefined) {
            return []
        }

        return uniqueConfigProperties(candidate.mixinDependencyNames.flatMap((name) => {
            // Same resolution order as the dependency loop above: same file, the named
            // import binding, or a QUALIFIED `lib.Logger` through its namespace import.
            const separator = name.indexOf(".")

            if (separator >= 0) {
                const binding      = separator === name.lastIndexOf(".")
                    ? candidate.importMap.get(name.slice(0, separator))
                    : undefined
                const qualifiedKey = binding?.namespace === true
                    ? registryKey(binding.resolvedFileName, name.slice(separator + 1))
                    : undefined

                return qualifiedKey !== undefined && mixinRegistry.has(qualifiedKey)
                    ? accumulateRegisteredMixinConfig(qualifiedKey, mixinRegistry, new Set())
                    : []
            }

            const sameFileKey = registryKey(candidate.fileName, name)

            if (mixinRegistry.has(sameFileKey)) {
                return accumulateRegisteredMixinConfig(sameFileKey, mixinRegistry, new Set())
            }

            const imported = candidate.importMap.get(name)

            if (imported !== undefined) {
                const importedKey = registryKey(imported.resolvedFileName, imported.importedName)

                if (mixinRegistry.has(importedKey)) {
                    return accumulateRegisteredMixinConfig(importedKey, mixinRegistry, new Set())
                }
            }

            return []
        }))
    }

    // The construction config an ordinary class contributes on its own: its public
    // fields plus those of every mixin it consumes (transitively). Without the mixin
    // half, subclassing an imported construction *consumer* would drop the base's
    // mixin config from the subclass's `.new`.
    const ownPlusMixinConfig = (candidate: ConstructionBaseCandidate): ConfigProperty[] =>
        uniqueConfigProperties([
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

// Construction classes in an emitted `.d.ts`: a class declaration with a generated
// `static new(props: <config>): Self`. The config (already aggregated at emit time) is
// read straight off the parameter type (`Pick<Self, "a" | "b"> & Partial<Pick<Self,
// "c">>`), so downstream subclassing needs no further resolution.
function collectDeclarationFileConstructionBases(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Array<{ name: string, configProperties: ConfigProperty[] }> {
    const bases: Array<{ name: string, configProperties: ConfigProperty[] }> = []
    // The generated `static new(props: <Name>Config)` references an exported config
    // alias declared alongside it in the same `.d.ts`; map alias name -> body so the
    // reader can resolve the reference back to its `Pick<...> & Partial<...>` shape.
    const configAliases = collectDeclarationFileTypeAliases(tsInstance, sourceFile)

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isClassDeclaration(statement) || statement.name === undefined) {
            continue
        }

        const staticNew = statement.members.find((member): member is ts.MethodDeclaration =>
            tsInstance.isMethodDeclaration(member) &&
            member.name !== undefined &&
            propertyNameText(tsInstance, member.name) === "new" &&
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword))

        const configType = staticNew?.parameters[0]?.type

        if (configType === undefined) {
            continue
        }

        bases.push({
            name             : statement.name.text,
            configProperties : configPropertiesFromConstructionNewParam(tsInstance, configType, false, configAliases, new Set())
        })
    }

    return bases
}

function collectDeclarationFileTypeAliases(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Map<string, ts.TypeNode> {
    const aliases = new Map<string, ts.TypeNode>()

    for (const statement of sourceFile.statements) {
        if (tsInstance.isTypeAliasDeclaration(statement)) {
            aliases.set(statement.name.text, statement.type)
        }
    }

    return aliases
}

// Names (with optionality) carried by a generated construction config type:
// `Pick<Self, "a" | "b">` (required), `Partial<Pick<Self, "c">>` (optional),
// intersections of those, and a reference to a `<Name>Config` alias declared in the
// same `.d.ts` (resolved through `configAliases`). Type arguments on a generic alias
// are irrelevant - the config field names are string literals inside its `Pick`.
// Anything else contributes nothing.
function configPropertiesFromConstructionNewParam(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    optional: boolean,
    configAliases: Map<string, ts.TypeNode>,
    seenAliases: Set<string>
): ConfigProperty[] {
    if (tsInstance.isIntersectionTypeNode(typeNode)) {
        return uniqueConfigProperties(typeNode.types.flatMap((type) =>
            configPropertiesFromConstructionNewParam(tsInstance, type, optional, configAliases, seenAliases)))
    }

    if (tsInstance.isParenthesizedTypeNode(typeNode)) {
        return configPropertiesFromConstructionNewParam(tsInstance, typeNode.type, optional, configAliases, seenAliases)
    }

    if (!tsInstance.isTypeReferenceNode(typeNode) || !tsInstance.isIdentifier(typeNode.typeName)) {
        return []
    }

    if (typeNode.typeName.text === "Partial" && typeNode.typeArguments?.[0] !== undefined) {
        return configPropertiesFromConstructionNewParam(tsInstance, typeNode.typeArguments[0], true, configAliases, seenAliases)
    }

    if (typeNode.typeName.text === "Pick" && typeNode.typeArguments?.[1] !== undefined) {
        return literalStringNames(tsInstance, typeNode.typeArguments[1]).map((name) => ({ name, optional }))
    }

    const aliasBody = configAliases.get(typeNode.typeName.text)

    if (aliasBody !== undefined && !seenAliases.has(typeNode.typeName.text)) {
        seenAliases.add(typeNode.typeName.text)

        return configPropertiesFromConstructionNewParam(tsInstance, aliasBody, optional, configAliases, seenAliases)
    }

    return []
}

function literalStringNames(tsInstance: TypeScript, typeNode: ts.TypeNode): string[] {
    if (tsInstance.isLiteralTypeNode(typeNode) && tsInstance.isStringLiteral(typeNode.literal)) {
        return [ typeNode.literal.text ]
    }

    if (tsInstance.isUnionTypeNode(typeNode)) {
        return typeNode.types.flatMap((type) => literalStringNames(tsInstance, type))
    }

    return []
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

function collectDeclarationFileMixinCandidates(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): Candidate[] {
    if (!sourceFile.text.includes(runtimeMixinClassName)) {
        return []
    }

    const facts                   = getSourceFileFacts(tsInstance, sourceFile, options)
    const candidates: Candidate[] = []
    const interfaces              = new Map<string, ts.InterfaceDeclaration>()
    const defaultExportNames      = new Set<string>()

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

            // The mixin's `RuntimeMixinClass<Base>` marker carries its required base. When
            // that base is the package `Base`, the mixin is construction-enabled, so a
            // consumer of it (from this declaration file) gets a generated `.new`. The flag
            // is otherwise lost for `.d.ts`, leaving downstream construction undetected. The
            // package base also appears in the merged `interface … extends Base, …`, so drop
            // it from the dependency (mixin) names — it is the base, not a consumed mixin.
            const requiredBaseIdentifier    = runtimeMixinClassRequiredBaseIdentifier(tsInstance, declaration.type)
            const requiredBaseIsPackageBase = requiredBaseIdentifier !== undefined &&
                isPackageBaseExpression(tsInstance, requiredBaseIdentifier, options, facts)
            const extendsNames              = interfaceExtendsNames(tsInstance, interfaces.get(declaration.name.text))

            candidates.push({
                sourceFile,
                name            : declaration.name.text,
                dependencyNames : requiredBaseIsPackageBase
                    ? extendsNames.filter((name) => name !== requiredBaseIdentifier.text)
                    : extendsNames,
                requiredBaseName    : requiredBaseIsPackageBase ? requiredBaseIdentifier.text : undefined,
                requiredBaseIsPackageBase,
                configProperties    : interfaceConfigProperties(tsInstance, interfaces.get(declaration.name.text)),
                declarationHeritage : true,
                defaultExport
            })
        }
    }

    return candidates
}

// Locates the `RuntimeMixinClass<…>` marker type reference inside a mixin value's
// declared type, descending through intersections/unions (`… & RuntimeMixinClass<Base>`)
// and parentheses. Returns the reference node itself (so callers can read its type
// argument), or undefined when the type carries no such marker.
function findRuntimeMixinClassReference(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode
): ts.TypeReferenceNode | undefined {
    if (tsInstance.isTypeReferenceNode(typeNode) &&
        tsInstance.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === runtimeMixinClassName
    ) {
        return typeNode
    }

    if (tsInstance.isIntersectionTypeNode(typeNode) || tsInstance.isUnionTypeNode(typeNode)) {
        for (const type of typeNode.types) {
            const found = findRuntimeMixinClassReference(tsInstance, type)

            if (found !== undefined) {
                return found
            }
        }

        return undefined
    }

    if (tsInstance.isParenthesizedTypeNode(typeNode)) {
        return findRuntimeMixinClassReference(tsInstance, typeNode.type)
    }

    return undefined
}

// The required-base identifier from a `RuntimeMixinClass<Base>` marker inside the
// mixin value's declared type. `RuntimeMixinClass` with no type argument (a mixin
// without a required base) yields undefined.
function runtimeMixinClassRequiredBaseIdentifier(tsInstance: TypeScript, typeNode: ts.TypeNode): ts.Identifier | undefined {
    const argument = findRuntimeMixinClassReference(tsInstance, typeNode)?.typeArguments?.[0]

    return argument !== undefined &&
        tsInstance.isTypeReferenceNode(argument) &&
        tsInstance.isIdentifier(argument.typeName)
        ? argument.typeName
        : undefined
}

function typeReferencesRuntimeMixinClass(tsInstance: TypeScript, typeNode: ts.TypeNode): boolean {
    return findRuntimeMixinClassReference(tsInstance, typeNode) !== undefined
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
