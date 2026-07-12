import type * as ts from "typescript"
import type { PluginConfig } from "ts-patch"
import type { RequiredBaseContext } from "./required-base-plan.js"
import { normalizePath } from "./util.js"
import type { TypeScript } from "./util.js"

export type MixinClassTransformerConfig = PluginConfig & {
    packageName?                : string,
    decoratorName?              : string,
    mode?                       : MixinClassTransformerMode,
    staticCollisionCheck?       : StaticCollisionCheckMode | boolean,
    fillMissedInitializersWith? : FillMissedInitializersWith
}

export type MixinClassTransformerMode = "emit" | "ide"
export type StaticCollisionCheckMode = false | "never" | "strict"

// What a construction class's fields that have no source initializer are filled with in the
// emitted code, to give every instance a stable object shape (monomorphic property access).
// `"nothing"` leaves fields untouched. Filled with a non-null assertion (`undefined!`/`null!`)
// so the property type is never widened.
export type FillMissedInitializersWith = "undefined" | "null" | "nothing"

export type TransformOptions = {
    packageName                : string,
    decoratorName              : string,
    sourceView                 : boolean,
    staticCollisionCheck       : StaticCollisionCheckMode,
    fillMissedInitializersWith : FillMissedInitializersWith,
    verifyLinearization        : boolean,
    disableLinearizationPlan   : boolean,
    // The EFFECTIVE `useDefineForClassFields` of the compilation (explicit option, or the
    // target>=ES2022 default), threaded in by the host. Gates the accessor-over-field half of
    // the TS990010 member-kind override guard: under SET semantics a base field assignment
    // fires an overriding accessor's setter, so that override is sound and stays legal.
    useDefineForClassFields    : boolean,
    // The compilation's decorator mode, threaded in by the host. Selects the emit shape that
    // preserves USER decorators on a `@mixin` class: standard (TC39) mode wraps the value in
    // an IIFE holding a real decorated class declaration (the compiler emits the decorator
    // machinery itself); legacy mode folds the decorators over the value.
    experimentalDecorators     : boolean,
    // The compilation's `isolatedDeclarations`, threaded in by the host. Gates the factory's
    // EXPLICIT return annotation (without it every exported factory's inferred return is a
    // TS9007 under the option). Gated rather than always-on: the annotation's inherited-statics
    // tail references dependencies' VALUE types, whose annotations reference THEIR
    // dependencies' — nested `Omit<ClassStatics<…>>` chains that hit the checker's
    // instantiation-depth ceiling (TS2589) on deep dependency windows, whereas the inferred
    // `typeof __X$class` is a flat class type the checker resolves without nesting.
    isolatedDeclarations       : boolean
}

export type MixinDecoratorImports = {
    identifiers : Set<string>,
    namespaces  : Set<string>
}

export type RegisteredMixin = {
    fileName                  : string,
    name                      : string,
    defaultExport             : boolean,
    // Dependency registry keys (mixin entries from implements)
    dependencies              : string[],
    requiredBaseName          : string | undefined,
    // The mixin's required base is the package `Base` itself (the construction
    // base), so consumers must import it from the package rather than from the
    // mixin's own module, and are construction-enabled.
    requiredBaseIsPackageBase : boolean,
    configProperties          : ConfigProperty[],
    // `.d.ts` mixins only: the published `"new"(props: …)` parameter is REQUIRED. The
    // fact transport strips computed/symbol keys (unspellable here), so their
    // requiredness survives ONLY through this flag — a downstream `.new` keeps a
    // required parameter even when every RESPELLED key is optional (§13.8).
    configRequiresArgument?   : boolean
}

export type MixinRegistry = Map<string, RegisteredMixin>

// Ordinary (non-mixin) classes that transitively extend the package `Base`, so a
// `extends`/required-base reference to them from another file can be recognised as
// a construction base without re-reading the defining file. `configProperties`
// accumulates the class's own public config fields plus those of its ancestors up
// to `Base`, which is exactly what a downstream `.new(...)` config type needs.
export type ConstructionBaseEntry = {
    fileName                : string,
    name                    : string,
    isBaseDescendant        : boolean,
    configProperties        : ConfigProperty[],
    // `.d.ts` bases only — see `RegisteredMixin.configRequiresArgument`.
    configRequiresArgument? : boolean
}

export type ConstructionBaseRegistry = Map<string, ConstructionBaseEntry>

export type CrossFileContext = {
    registry               : MixinRegistry,
    constructionBases      : ConstructionBaseRegistry,
    requiredBases          : RequiredBaseContext,
    cacheKey               : string,
    resolveModuleFileName  : (specifier: string, containingFile: string) => string | undefined,
    canImportRuntimeValue? : (resolvedFileName: string) => boolean,
    // Per-mixin C3 linearizations (registry key -> linearized keys). The result
    // depends only on the registry graph, so it is shared across every consumer
    // and file in the program instead of being rebuilt per linearizeDependencies.
    linearizationCache     : Map<string, string[]>
}

// A transformer-authored diagnostic: a real error we synthesize (our own message / code / span)
// instead of encoding it as a `never`-typed alias for the checker to surface as TS2344. Positioned
// on the ORIGINAL on-disk source, so it lands identically in the emit (reprinted) and source-view
// (position-preserving) paths — `wrapProgramDiagnostics` attaches the real `file` and appends it.
export type NativeMixinDiagnostic = {
    fileName    : string,
    start       : number,
    length      : number,
    code        : number,
    category    : ts.DiagnosticCategory,
    messageText : string
}

// Native diagnostic codes — outside TypeScript's own numeric range so they are unmistakably ours
// and stable across versions (they surface as `TS990001`, …).
export const mixinDiagnosticCode = {
    MixinExtendsMixin              : 990001,
    AnonymousDefaultMixin          : 990002,
    AnonymousMixinConsumer         : 990003,
    MixinInvalidDeclaration        : 990004,
    MixinUnsupportedBase           : 990005,
    MixinMissingRuntime            : 990006,
    MixinLinearizationConflict     : 990007,
    MixinUsedBeforeDeclaration     : 990008,
    MixinNamespaceMerge            : 990009,
    MixinMemberKindOverride        : 990010,
    MixinPartialAccessorOverride   : 990011,
    MixinManualApplication         : 990012,
    MixinRequiredBaseConflict      : 990013,
    MixinRequiredBaseMismatch      : 990014,
    ConstructionConfigNameReserved : 990015
} as const

// The one shared constructor for a transformer-authored error: spans `node`'s own
// `getStart..getEnd` range on the original on-disk source (every push site used to
// hand-inline this literal).
export function nativeDiagnosticOn(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    node: ts.Node,
    code: number,
    messageText: string
): NativeMixinDiagnostic {
    const start = node.getStart(sourceFile)

    return {
        fileName : sourceFile.fileName,
        start,
        length   : node.getEnd() - start,
        code,
        category : tsInstance.DiagnosticCategory.Error,
        messageText
    }
}

export type ImportedNameBinding = {
    resolvedFileName : string,
    importedName     : string,
    typeOnly         : boolean,
    // True for a NAMESPACE import binding (`import * as lib` → key "lib",
    // `importedName: "*"`): its MEMBERS are what qualified references resolve through;
    // name-keyed consumers must not treat it as a value/type binding itself.
    namespace?       : boolean
}

// The per-file import-name map: local binding name (or namespace alias) -> what it imports.
export type ImportMap = Map<string, ImportedNameBinding>

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
        localName     : string,
        import        : { specifier: string, importedName: string, localName: string } | undefined,
        // The required base resolves to the package `Base`, so a consumer using
        // this mixin is construction-enabled even without a local `Base` import.
        isPackageBase : boolean
    } | undefined,
    dependencies         : string[],
    declaration          : ts.ClassDeclaration | undefined,
    configProperties     : ConfigProperty[],
    missingRuntimeImport : {
        specifier    : string,
        importedName : string
    } | undefined
}

// One NAMED class declaration with the position range and nesting depth of its enclosing
// statement-list scope (the whole file for a top-level class; a CaseBlock counts as ONE scope
// — every clause of a `switch` shares it). Collected once during the facts pass; lexical
// mixin resolution picks the deepest same-named entry whose scope contains the reference.
export type ClassScopeEntry = {
    declaration : ts.ClassDeclaration,
    scopeStart  : number,
    scopeEnd    : number,
    depth       : number
}

export type FileMixinContext = {
    // Every NAMED class declaration in the file (top-level and nested), indexed by name with
    // its enclosing-scope range — collected during the facts pass (`classScopesByName` on
    // `SourceFileFacts`). Lexical mixin resolution (`resolveLexicalMixinRef`) answers from the
    // deepest same-named entry whose scope contains the reference, in O(same-named entries)
    // per lookup with no tree walk.
    classScopesByName  : Map<string, ClassScopeEntry[]>,
    byLocalName        : Map<string, ResolvedMixinRef>,
    byKey              : Map<string, ResolvedMixinRef>,
    // Every LOCALLY-declared `@mixin` keyed by its own declaration node, so a mixin is detected
    // for expansion by identity rather than by name. Unlike `byLocalName` (flat, first-name-wins),
    // this holds a distinct ref for every nested mixin even when two share a name across sibling
    // scopes — each expands from its OWN declaration.
    byDeclaration      : Map<ts.ClassDeclaration, ResolvedMixinRef>,
    // Program-wide cross-file context, when the program contains mixins or
    // construction bases. Used to resolve imported/required construction bases.
    crossFile?         : CrossFileContext,
    // Factories actually used in generated chains.
    usedFactoryImports : Map<string, { specifier: string, importedName: string, localName: string }>,
    // Shared with the program-wide cache via CrossFileContext when available, so
    // per-mixin C3 linearizations are reused across consumers and files.
    linearizationCache : Map<string, string[]>,
    // The per-program native-diagnostic sink, shared by reference with `wrapProgramDiagnostics`.
    // Present even when there is no cross-file context (a lone anonymous `@mixin` is not in the
    // registry, so its diagnostic could not ride on `crossFile`). Empty for in-process transforms.
    nativeDiagnostics  : NativeMixinDiagnostic[]
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
    name        : string,
    typeNode    : ts.TypeNode,
    staticNames : Set<string> | undefined
}

export type ConfigProperty = {
    name             : string,
    optional         : boolean,
    // For a settable ACCESSOR, the setter's parameter type. The config field is then
    // emitted as an explicit `name?: <valueType>` member rather than `Pick<Class, name>`,
    // because `Pick` reads the GETTER type — wrong when get/set types differ (the setter,
    // which `.new`'s `Object.assign` actually invokes, may accept a wider type). Absent for
    // data fields (and accessors resolved cross-file without a type node), which use `Pick`.
    valueType?       : ts.TypeNode,
    // A COMPUTED key (`public [field]!: string` over a module-level const / unique symbol):
    // the key expression's dotted text. The config references the key as `typeof <entity>`
    // (a `Pick` key or a computed explicit member), so it is only valid where the entity
    // RESOLVES — cross-file contributors strip these (`transplantableConfigProperties`).
    // `name` then holds the bracketed `[field]` spelling (distinct from a string-named
    // `field` member — different runtime keys must never dedup together).
    computedKeyName? : string
}

// Drops config keys that cannot be spelled outside their declaring file (computed keys
// reference a module-scoped const/symbol by name). Applied wherever config properties
// cross a file boundary; the runtime still assigns such keys — they just leave the
// consumer's compile-time config, a documented narrower limitation.
export function transplantableConfigProperties(values: ConfigProperty[]): ConfigProperty[] {
    return values.filter((value) => value.computedKeyName === undefined)
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
    packageName                : "ts-mixin-class",
    decoratorName              : "mixin",
    sourceView                 : false,
    staticCollisionCheck       : "never",
    fillMissedInitializersWith : "undefined",
    verifyLinearization        : true,
    disableLinearizationPlan   : false,
    // Conservative default: define semantics is the modern (target>=ES2022) TS default, and
    // over-diagnosing is safer than silently burying an accessor. Hosts overwrite it with the
    // compilation's effective value.
    useDefineForClassFields    : true,
    // Standard (TC39) decorators are TypeScript's default mode; hosts overwrite it with the
    // compilation's option.
    experimentalDecorators     : false,
    // The option is off by default; hosts overwrite it with the compilation's value.
    isolatedDeclarations       : false
}

// Merges duplicate config keys. INPUT CONTRACT: contributors are ordered NEAREST-first
// (own members, then mixins in linearization order, then the base chain) — every assembly
// site upholds this. The NEAREST declaration chooses the key's REPRESENTATION (a field goes
// through `Pick`, a setter keeps its explicit write type — nearest-wins, §7.29, the config
// twin of runtime member resolution); requiredness stays MONOTONIC regardless of order —
// one `!` contributor anywhere keeps the key required (§7.28).
export function uniqueConfigProperties(values: ConfigProperty[]): ConfigProperty[] {
    const byName = new Map<string, ConfigProperty>()

    for (const value of values) {
        const existing = byName.get(value.name)

        byName.set(value.name, {
            name            : value.name,
            optional        : (existing?.optional ?? true) && value.optional,
            valueType       : existing === undefined ? value.valueType : existing.valueType,
            computedKeyName : existing === undefined ? value.computedKeyName : existing.computedKeyName
        })
    }

    return [ ...byName.values() ]
}

// Accumulates the full construction config a registered mixin contributes: its own
// public fields plus those of every mixin it depends on, transitively. Used both when
// a consumer applies the mixin and when an ordinary class consuming the mixin is used
// as a construction base for a subclass (so the subclass's `.new` sees the field).
// Own fields lead: the mixin is NEARER than its dependencies (nearest-first contract).
export function accumulateRegisteredMixinConfig(
    key: string,
    registry: MixinRegistry,
    seen: Set<string>
): ConfigProperty[] {
    if (seen.has(key)) {
        return []
    }

    seen.add(key)

    const registered = registry.get(key)

    if (registered === undefined) {
        return []
    }

    return uniqueConfigProperties([
        ...registered.configProperties,
        ...registered.dependencies.flatMap((dependency) => accumulateRegisteredMixinConfig(dependency, registry, seen))
    ])
}

export function registryKey(fileName: string, name: string): string {
    return `${normalizePath(fileName)}::${name}`
}

// The file-name half of a registry key — e.g. to detect a `.d.ts`-origin entry.
export function registryKeyFileName(key: string): string {
    return key.slice(0, key.lastIndexOf("::"))
}

// Resolves a possibly-dotted reference name to its registry key through the import map:
// a two-level `ns.Member` resolves through a NAMESPACE binding (`import * as ns`) to
// `registryKey(<ns module>, Member)`; a plain name resolves through its named-import
// binding. Returns undefined for a three-level name, an unknown binding, or a dotted
// prefix that is not a namespace import. (This walk used to be hand-inlined at every
// cross-file resolution site.)
export function importedBindingRegistryKey(
    name: string,
    importMap: ImportMap
): string | undefined {
    const separator = name.indexOf(".")

    if (separator >= 0) {
        const binding = name.indexOf(".", separator + 1) < 0
            ? importMap.get(name.slice(0, separator))
            : undefined

        return binding?.namespace === true
            ? registryKey(binding.resolvedFileName, name.slice(separator + 1))
            : undefined
    }

    const imported = importMap.get(name)

    return imported === undefined
        ? undefined
        : registryKey(imported.resolvedFileName, imported.importedName)
}
