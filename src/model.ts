import type * as ts from "typescript"
import type { PluginConfig } from "ts-patch"
import type { TypeScript } from "./util.js"

export type MixinClassTransformerConfig = PluginConfig & {
    packageName? : string,
    decoratorName? : string,
    mode? : MixinClassTransformerMode,
    staticCollisionCheck? : StaticCollisionCheckMode | boolean,
    constructionConfig? : ConstructionConfigMode,
    allowUndefinedForRequiredProperties? : boolean
}

export type MixinClassTransformerMode = "emit" | "ide"
export type StaticCollisionCheckMode = false | "never" | "strict"
export type ConstructionConfigMode = "public-only" | "instance-type"

export type TransformOptions = {
    packageName : string,
    decoratorName : string,
    sourceView : boolean,
    staticCollisionCheck : StaticCollisionCheckMode,
    constructionConfig : ConstructionConfigMode,
    allowUndefinedForRequiredProperties : boolean
}

export type MixinDecoratorImports = {
    identifiers : Set<string>,
    namespaces  : Set<string>
}

export type RegisteredMixin = {
    fileName     : string,
    name         : string,
    defaultExport : boolean,
    // Dependency registry keys (mixin entries from implements)
    dependencies : string[],
    requiredBaseName : string | undefined,
    // The mixin's required base is the package `Base` itself (the construction
    // base), so consumers must import it from the package rather than from the
    // mixin's own module, and are construction-enabled.
    requiredBaseIsPackageBase : boolean,
    configProperties : ConfigProperty[]
}

export type MixinRegistry = Map<string, RegisteredMixin>

// Ordinary (non-mixin) classes that transitively extend the package `Base`, so a
// `extends`/required-base reference to them from another file can be recognised as
// a construction base without re-reading the defining file. `configProperties`
// accumulates the class's own public config fields plus those of its ancestors up
// to `Base`, which is exactly what a downstream `.new(...)` config type needs.
export type ConstructionBaseEntry = {
    fileName : string,
    name : string,
    isBaseDescendant : boolean,
    configProperties : ConfigProperty[]
}

export type ConstructionBaseRegistry = Map<string, ConstructionBaseEntry>

export type CrossFileContext = {
    registry : MixinRegistry,
    constructionBases : ConstructionBaseRegistry,
    cacheKey : string,
    resolveModuleFileName : (specifier: string, containingFile: string) => string | undefined
    canImportRuntimeValue? : (resolvedFileName: string) => boolean
    // Per-mixin C3 linearizations (registry key -> linearized keys). The result
    // depends only on the registry graph, so it is shared across every consumer
    // and file in the program instead of being rebuilt per linearizeDependencies.
    linearizationCache : Map<string, string[]>
}

export type ImportedNameBinding = {
    resolvedFileName : string,
    importedName     : string,
    typeOnly         : boolean
}

// Mixin reference from the transformed file's point of view
export type ResolvedMixinRef = {
    key              : string,
    className        : string,
    // Mixin value name in this file (same-file or imported); undefined for a
    // transitive dependency the file does not import.
    localValueName   : string | undefined,
    localFactoryName : string,
    factoryImport    : { specifier: string, importedName: string } | undefined,
    requiredBase     : {
        localName : string,
        import    : { specifier: string, importedName: string, localName: string } | undefined,
        // The required base resolves to the package `Base`, so a consumer using
        // this mixin is construction-enabled even without a local `Base` import.
        isPackageBase : boolean
    } | undefined,
    dependencies     : string[],
    declaration      : ts.ClassDeclaration | undefined
    configProperties : ConfigProperty[]
    missingRuntimeImport : {
        specifier : string,
        importedName : string
    } | undefined
}

export type FileMixinContext = {
    byLocalName : Map<string, ResolvedMixinRef>,
    byKey       : Map<string, ResolvedMixinRef>,
    // Program-wide cross-file context, when the program contains mixins or
    // construction bases. Used to resolve imported/required construction bases.
    crossFile? : CrossFileContext,
    // Factories actually used in generated chains.
    usedFactoryImports : Map<string, { specifier: string, importedName: string, localName: string }>,
    // Shared with the program-wide cache via CrossFileContext when available, so
    // per-mixin C3 linearizations are reused across consumers and files.
    linearizationCache : Map<string, string[]>
}

export type RequiredBaseValidation = {
    typeParameter : ts.TypeParameterDeclaration,
    typeArgument  : ts.TypeNode
}

export type RequiredBaseRequirement = {
    typeNode : ts.TypeNode,
    name     : string
}

export type StaticSource = {
    name : string,
    typeNode : ts.TypeNode,
    staticNames : Set<string> | undefined
}

export type ConfigProperty = {
    name     : string,
    optional : boolean
}

export type MixinDeclarationDiagnostic = {
    node    : ts.Node,
    message : string
}

export class DependencyLinearizationError extends Error {
    constructor(readonly pendingSequences: readonly string[][]) {
        super("Cannot linearize mixin classes: inconsistent requirements")
    }
}

export const defaultTransformOptions: TransformOptions = {
    packageName                                : "ts-mixin-class",
    decoratorName                              : "mixin",
    sourceView                                 : false,
    staticCollisionCheck                       : "never",
    constructionConfig                         : "public-only",
    allowUndefinedForRequiredProperties : false
}

export const anyConstructorName = "AnyConstructor"
export const classStaticsName   = "ClassStatics"
export const defineMixinClassName = "defineMixinClass"
export const mixinChainName = "mixinChain"
export const mixinApplicationName = "MixinApplication"
export const mixinFactoryName = "MixinFactory"
export const runtimeMixinClassName = "RuntimeMixinClass"
export const mixinClassValueName = "MixinClassValue"
export const staticNeverConflictKeysName = "StaticNeverConflictKeys"
export const staticStrictConflictKeysName = "StaticStrictConflictKeys"
export const metadataBaseImportName = "base"
export const metadataBaseLocalName = "__mixinBase"
export const mixinFactorySuffix = "$mixin"
export const consumerBaseSuffix = "$base"
export const consumerEmptyBaseSuffix = "$empty"
export const mixinValueSuffix = "$mixinValue"

export function staticConflictKeysName(mode: Exclude<StaticCollisionCheckMode, false>): string {
    return mode === "strict" ? staticStrictConflictKeysName : staticNeverConflictKeysName
}

export function generatedName(name: string, suffix: string): string {
    return `__${name}${suffix}`
}

export function propertyNameText(tsInstance: TypeScript, name: ts.PropertyName): string | undefined {
    if (tsInstance.isIdentifier(name) || tsInstance.isStringLiteral(name) || tsInstance.isNumericLiteral(name)) {
        return name.text
    }

    return undefined
}

export function uniqueConfigProperties(values: ConfigProperty[]): ConfigProperty[] {
    const byName = new Map<string, ConfigProperty>()

    for (const value of values) {
        const existing = byName.get(value.name)

        byName.set(value.name, {
            name     : value.name,
            optional : (existing?.optional ?? true) && value.optional
        })
    }

    return [ ...byName.values() ]
}

export function registryKey(fileName: string, name: string): string {
    return `${normalizePath(fileName)}::${name}`
}

export function normalizePath(fileName: string): string {
    return fileName.replaceAll("\\", "/")
}

export function shouldSkipFileName(fileName: string): boolean {
    const normalizedFileName = normalizePath(fileName)

    return normalizedFileName.includes("/node_modules/") ||
        normalizedFileName.endsWith(".d.ts") ||
        !/\.[cm]?tsx?$/.test(normalizedFileName)
}

export function implementsTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.ExpressionWithTypeArguments[] {
    const clause = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })

    return clause === undefined ? [] : [ ...clause.types ]
}

export function requiredBaseType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.ExpressionWithTypeArguments | undefined {
    return extendsClause(tsInstance, declaration)?.types[0]
}

export function requiredBaseIdentifierName(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): string | undefined {
    const requiredBase = requiredBaseType(tsInstance, declaration)

    return requiredBase !== undefined && tsInstance.isIdentifier(requiredBase.expression)
        ? requiredBase.expression.text
        : undefined
}

export function extendsClause(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.HeritageClause | undefined {
    return declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })
}

export function isNamedClassElement(
    member: ts.ClassElement
): member is ts.ClassElement & { name: ts.PropertyName } {
    return member.name !== undefined
}
