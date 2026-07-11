import type * as ts from "typescript"

import type { MixinRegistry, RegisteredMixin, ResolvedMixinRef, TransformOptions } from "./model.js"
import { registryKey } from "./model.js"
import { extendsClause } from "./heritage.js"
import { collectTypeReferenceNames, substituteTypeParameterReferences } from "./expand-util.js"
import { runtimeMixinClassRequiredBaseTypeNode, typeReferencesRuntimeMixinClass } from "./registry-declaration-file.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import { deepCloneNode, normalizePath } from "./util.js"
import type { TypeScript } from "./util.js"

// Compile-time REQUIRED-BASE selection over the transitive C3 closure: collect every
// mixin's own required-base constraint, order the set by NOMINAL class inheritance
// (checker-backed, lazily, cached), and let the expanders emit a one-based plan index
// into the materialized linearization. Design rules this module enforces:
//
// - EAGER work is syntactic + mixin-own-constraints only. Explicit consumer bases are
//   resolved LAZILY from the declaration node the expander already holds (never from a
//   text-prefiltered file scan — a consumer file routinely never mentions the package
//   name), and dependency symbol-linking happens on first resolution. A program with no
//   required-base constraints gets an inert context that costs nothing per rebuild.
// - Every checker query is GUARDED: a transient mid-edit source-view tree must degrade
//   the affected relation to "unknown" — never abort Program creation, and never
//   manufacture "unrelated" (a transient false TS990013 while the user types).
// - Relations are TRI-STATE ("extends" | "unrelated" | "unknown"). Generic ancestry is
//   compared under an identity-substitution environment (checker.getBaseTypes returns
//   UNINSTANTIATED bases), and a generic mixin's constraint is interpreted under its
//   USE-SITE substitution (`implements M<U>` maps the declared `T` -> `U`), composed
//   transitively along the dependency chain. Type parameters compare SYMBOLICALLY (by
//   parameter object identity): the same parameter equals itself; a parameter against
//   anything else is "unknown" — never "unrelated". A comparison that still reaches a
//   free type parameter is "unknown", which degrades the whole resolution to
//   INDETERMINATE: no diagnostic, no plan — the runtime scan (which sees real
//   constructors) decides precisely.
// - The transform cache key is SHAPE-based (file, mixin name, base spelling, ancestry
//   fingerprint) — never byte positions, or an edit above any mixin would invalidate
//   every cached transformed file in the program.

export type RequiredBaseConstraint = {
    // In-program identity (location-based) — keys the relation cache; dies with the program.
    id             : string,
    declarationKey : string,
    // Position-free identity — feeds the cross-program transform cache key.
    cacheIdentity  : string,
    mixin          : RegisteredMixin | undefined,
    mixinName      : string,
    baseName       : string,
    type           : ts.Type,
    // The owning declaration (a `@mixin` class, or the PUBLISHED interface of a `.d.ts`
    // mixin — the interface's `extends Base<T>` retains the type-parameter mapping the
    // value marker erases to `any`) + the heritage node the constraint came from
    // (ORIGINAL program nodes). Absent for a marker-only `.d.ts` constraint (no matching
    // interface). Feed the use-site instantiation of the emitted implicit base.
    declaration    : ts.ClassDeclaration | ts.InterfaceDeclaration | undefined,
    heritageNode   : ts.ExpressionWithTypeArguments | undefined
}

// A constraint interpreted under a use-site substitution environment: `env` maps the
// owning mixin's type-parameter objects to the identities they are instantiated with
// along the consumer's dependency path. `baseDisplayName` is the user-facing rendering
// of the constraint under that substitution (`GenericBase<string>`, not the declared
// `GenericBase<T>`).
export type RequiredBaseInstance = {
    constraint      : RequiredBaseConstraint,
    env             : IdentityEnv,
    baseDisplayName : string
}

export type RequiredBaseConflict = {
    left  : RequiredBaseInstance,
    right : RequiredBaseInstance
}

export type RequiredBaseMismatch = {
    actual   : RequiredBaseInstance,
    required : RequiredBaseInstance
}

export type RequiredBaseResolution = {
    selected         : RequiredBaseInstance | undefined,
    conflict         : RequiredBaseConflict | undefined,
    explicitMismatch : RequiredBaseMismatch | undefined,
    // A relation could not be decided (free generic parameters, or a guarded checker
    // failure): no selection, no conflict — plan emission degrades to the runtime scan.
    indeterminate    : boolean
}

// The selected ref and its ONE-BASED plan index over the materialized linearization.
// `plan: 0` asserts "known unconstrained" (the caller pairs it with the `$empty` root);
// `plan: undefined` means "undecidable here" — the runtime scan is the safety net.
export type RequiredBasePlanSelection = {
    selectedRef : ResolvedMixinRef | undefined,
    plan        : number | undefined
}

// How the selected constraint's base type is expressed in the consuming file's scope:
// `raw` — the declared heritage carries no foreign type parameters, the expander's
// existing clone/alias path is sound as-is; `typeArguments` — the heritage's argument
// list instantiated with use-site nodes (all from the consuming file); undefined — not
// expressible there (the type-level base must be dropped rather than leak a foreign
// parameter; the plan/runtime side is unaffected).
export type RequiredBaseInstantiation =
    | { raw: true }
    | { raw: false, typeArguments: ts.TypeNode[] }

export type DirectRefEntry = {
    ref      : ResolvedMixinRef,
    // The use-site `implements M<U>` heritage node for DIRECT refs (clone-file node —
    // re-anchored by position internally before any checker query); undefined for a
    // mixin resolving its own ref.
    heritage : ts.ExpressionWithTypeArguments | undefined
}

export type RequiredBaseContext = {
    hasMixins              : boolean,
    hasConstraints         : boolean,
    cacheKey               : string,
    resolveDirectRefs      : (fileName: string, entries: DirectRefEntry[]) => RequiredBaseResolution,
    resolveRegisteredMixin : (mixin: RegisteredMixin) => RequiredBaseResolution,
    matchesRef             : (
        fileName: string,
        ref: ResolvedMixinRef,
        constraint: RequiredBaseConstraint
    ) => boolean,
    // The one place the "find the selected ref → one-based index, degrade to undefined on
    // a miss" encoding lives (REVIEW finding 1/10): both expanders consume this.
    planSelection : (
        fileName: string,
        linearized: readonly ResolvedMixinRef[],
        resolution: RequiredBaseResolution | undefined
    ) => RequiredBasePlanSelection,
    // Whether `mismatch` was produced by THIS declaration's own constraint — the
    // reporting gate that keeps a dependency's mismatch from being re-attributed to
    // every downstream mixin (REVIEW finding 7).
    ownsMismatch          : (fileName: string, declarationPosition: number, mismatch: RequiredBaseMismatch) => boolean,
    // Lazy: resolves the DECLARATION's own extends heritage on demand (cached), so the
    // check never depends on which files a collection pass happened to visit.
    explicitBaseSatisfies : (
        fileName: string,
        declaration: ts.ClassDeclaration,
        required: RequiredBaseInstance
    ) => boolean | undefined,
    instantiateBase           : (instance: RequiredBaseInstance) => RequiredBaseInstantiation | undefined,
    // The syntactic-tier sibling of `instantiateBase` for an IMPORTED ref's OWN
    // requirement: the published interface heritage instantiated with the direct
    // use-site arguments by parameter name. `raw` — nothing to substitute (the alias is
    // usable as-is); undefined — a generic requirement that cannot be expressed at this
    // site (callers must skip rather than emit a bare generic alias).
    importedBaseInstantiation : (
        refKey: string,
        useSiteHeritage: ts.ExpressionWithTypeArguments | undefined
    ) => RequiredBaseInstantiation | undefined,
    canImportBase : (resolvedFileName: string, exportedName: string) => boolean
}

type DependencyEdge =
    | { program: ProgramMixin, heritage: ts.ExpressionWithTypeArguments }
    | { registered: RegisteredMixin }

// Both a `@mixin` class in a program source file and the published INTERFACE of a
// `.d.ts` mixin resolve through this shape: type parameters, an optional own constraint,
// and dependency heritage edges with use-site type arguments.
type ProgramMixin = {
    locationKey             : string,
    declaration             : ts.ClassDeclaration | ts.InterfaceDeclaration,
    registered              : RegisteredMixin | undefined,
    ownConstraint           : RequiredBaseConstraint | undefined,
    dependencyHeritageTypes : readonly ts.ExpressionWithTypeArguments[],
    dependencyEdges         : DependencyEdge[] | undefined
}

type Relation = "extends" | "unrelated" | "unknown"

// Identity substitution: type-PARAMETER object → the identity it is instantiated with
// along the current path. Keyed by the ts.Type object (stable within one checker), so
// same-named parameters of different declarations never collide. `id` decides equality,
// `display` feeds diagnostics, `node` (when present) is a type node expressing the
// argument in the file under expansion, `free` taints the entry so a MISMATCH through it
// stays "unknown" (equal ids are still a definite "extends" — the same symbolic
// parameter always denotes the same future type).
type EnvEntry = {
    id      : string,
    display : string,
    free    : boolean,
    node    : ts.TypeNode | undefined
}

type IdentityEnv = ReadonlyMap<ts.Type, EnvEntry>

const emptyEnv: IdentityEnv = new Map()

const emptyResolution: RequiredBaseResolution = Object.freeze({
    selected         : undefined,
    conflict         : undefined,
    explicitMismatch : undefined,
    indeterminate    : false
})

const indeterminateResolution: RequiredBaseResolution = Object.freeze({
    selected         : undefined,
    conflict         : undefined,
    explicitMismatch : undefined,
    indeterminate    : true
})

const selectedResolution = (selected: RequiredBaseInstance | undefined): RequiredBaseResolution =>
    selected === undefined ? emptyResolution : { ...emptyResolution, selected }

export function buildRequiredBaseContext(
    tsInstance: TypeScript,
    program: ts.Program,
    registry: MixinRegistry,
    options: TransformOptions
): RequiredBaseContext {
    const checker              = program.getTypeChecker()
    const ownConstraintByMixin = new Map<RegisteredMixin, RequiredBaseConstraint>()
    const programMixins        = new Map<string, ProgramMixin>()

    let hasMixins = false

    // Phase 1 — eager, cheap: mixin discovery + OWN constraints only. The package-name
    // text prefilter is valid HERE (a mixin's file must import the decorator / the .d.ts
    // marker, so it always mentions the package); consumer-side data is never collected
    // eagerly (see explicitBaseSatisfies).
    // A published `.d.ts` mixin: its value marker (`RuntimeMixinClass<Base>`) names the
    // base but ERASES forwarded type parameters to `any`; the published INTERFACE
    // (`interface M<T> extends Base<T>, Dep<T>`) retains the full mapping. When the
    // interface is present the mixin becomes an interface-backed ProgramMixin — same
    // env-aware resolution as an in-program class; the marker stays the fallback.
    const collectDeclarationMixins = (sourceFile: ts.SourceFile): void => {
        let interfaces: Map<string, ts.InterfaceDeclaration> | undefined

        const interfaceFor = (name: string): ts.InterfaceDeclaration | undefined => {
            if (interfaces === undefined) {
                interfaces = new Map()

                for (const statement of sourceFile.statements) {
                    if (tsInstance.isInterfaceDeclaration(statement)) {
                        interfaces.set(statement.name.text, statement)
                    }
                }
            }

            return interfaces.get(name)
        }

        for (const statement of sourceFile.statements) {
            if (!tsInstance.isVariableStatement(statement)) {
                continue
            }

            for (const declaration of statement.declarationList.declarations) {
                if (!tsInstance.isIdentifier(declaration.name) || declaration.type === undefined) {
                    continue
                }

                if (!typeReferencesRuntimeMixinClass(tsInstance, declaration.type)) {
                    continue
                }

                const registered = registry.get(registryKey(sourceFile.fileName, declaration.name.text))

                if (registered === undefined) {
                    continue
                }

                const interfaceDeclaration = interfaceFor(declaration.name.text)
                const interfaceHeritage    = interfaceDeclaration?.heritageClauses
                    ?.find((clause) => clause.token === tsInstance.SyntaxKind.ExtendsKeyword)?.types ?? []
                // The interface entry for the required base — matched by the name the
                // registry recovered (an extends entry that is NOT a registered mixin).
                const baseHeritage = registered.requiredBaseName === undefined
                    ? undefined
                    : interfaceHeritage.find((entry) =>
                        tsInstance.isIdentifier(entry.expression) &&
                        entry.expression.text === registered.requiredBaseName)

                const markerBase = runtimeMixinClassRequiredBaseTypeNode(tsInstance, declaration.type)
                const hasBase    = markerBase !== undefined && markerBase.kind !== tsInstance.SyntaxKind.ObjectKeyword
                const baseType   = baseHeritage !== undefined
                    ? tryGetType(() => checker.getTypeAtLocation(baseHeritage))
                    : hasBase
                        ? tryGetType(() => checker.getTypeFromTypeNode(markerBase))
                        : undefined
                const location   = classLocationKey(sourceFile.fileName, declaration.pos)
                const constraint = !hasBase || baseType === undefined
                    ? undefined
                    : {
                        id             : location,
                        declarationKey : location,
                        cacheIdentity  : "",
                        mixin          : registered,
                        mixinName      : declaration.name.text,
                        baseName       : (baseHeritage ?? markerBase).getText(sourceFile),
                        type           : baseType,
                        declaration    : baseHeritage === undefined ? undefined : interfaceDeclaration,
                        heritageNode   : baseHeritage
                    }

                if (constraint !== undefined) {
                    ownConstraintByMixin.set(registered, constraint)
                }

                // Registered regardless of a base of its own: a base-less published mixin
                // still composes its GENERIC dependencies' constraints through its
                // interface heritage (the base entry is never a mixin, so leaving it in
                // the dependency list is harmless — edge resolution drops it).
                if (interfaceDeclaration !== undefined) {
                    programMixins.set(location, {
                        locationKey             : location,
                        declaration             : interfaceDeclaration,
                        registered,
                        ownConstraint           : constraint,
                        dependencyHeritageTypes : interfaceHeritage,
                        dependencyEdges         : undefined
                    })
                }
            }
        }
    }

    for (const sourceFile of program.getSourceFiles()) {
        if (!sourceFile.text.includes(options.packageName)) {
            continue
        }

        if (sourceFile.isDeclarationFile) {
            collectDeclarationMixins(sourceFile)
            continue
        }

        const facts = getSourceFileFacts(tsInstance, sourceFile, options)

        for (const classFacts of facts.classesByDeclaration.values()) {
            if (!classFacts.hasMixinDecorator || classFacts.name === undefined) {
                continue
            }

            hasMixins = true

            // A nested mixin deliberately never enters the cross-file registry; bind the
            // registry entry only when THIS declaration is the top-level one, or a nested
            // twin would resolve the top-level mixin's constraints (REVIEW finding 6).
            const registered = facts.classesByName.get(classFacts.name) === classFacts
                ? registry.get(registryKey(sourceFile.fileName, classFacts.name))
                : undefined
            const location   = classLocationKey(sourceFile.fileName, classFacts.declaration.pos)
            const heritage   = classFacts.extendsType
            const baseType   = heritage === undefined
                ? undefined
                : tryGetType(() => checker.getTypeAtLocation(heritage))
            const constraint = heritage === undefined || baseType === undefined
                ? undefined
                : {
                    id             : location,
                    declarationKey : location,
                    cacheIdentity  : "",
                    mixin          : registered,
                    mixinName      : classFacts.name,
                    baseName       : heritage.getText(sourceFile),
                    type           : baseType,
                    declaration    : classFacts.declaration,
                    heritageNode   : heritage
                }

            programMixins.set(location, {
                locationKey             : location,
                declaration             : classFacts.declaration,
                registered,
                ownConstraint           : constraint,
                dependencyHeritageTypes : classFacts.implementsTypes,
                dependencyEdges         : undefined
            })

            if (registered !== undefined && constraint !== undefined) {
                ownConstraintByMixin.set(registered, constraint)
            }
        }
    }

    const constraints = [ ...new Set([
        ...ownConstraintByMixin.values(),
        ...[ ...programMixins.values() ].flatMap((mixin) =>
            mixin.ownConstraint === undefined ? [] : [ mixin.ownConstraint ])
    ]) ]

    const hasConstraints = constraints.length > 0

    // --- identity / relation machinery (all checker access below is guarded) ----------

    // Stable symbolic identity for a type-parameter OBJECT: the same parameter always
    // renders the same id, two same-named parameters of different declarations never
    // collide. This is what makes `Base<U>` equal `Base<U>` for the consumer's own `U`.
    let symbolicCounter  = 0
    const symbolicIds    = new WeakMap<ts.Type, string>()
    const symbolicTypeId = (type: ts.Type): string => {
        const existing = symbolicIds.get(type)

        if (existing !== undefined) {
            return existing
        }

        const id = `#p${++symbolicCounter}`

        symbolicIds.set(type, id)

        return id
    }

    let opaqueCounter = 0

    // An entry that never equals anything (including itself from another edge): a value
    // we could not identify. Tainted `free`, so mismatches through it stay "unknown".
    const opaqueEntry = (): EnvEntry => ({
        id      : `opaque:${++opaqueCounter}`,
        display : "?",
        free    : true,
        node    : undefined
    })

    // Memo for env-free, free-parameter-free identities (the common case: concrete
    // constraint types and their ancestries). Env-dependent identities are cheap enough
    // and not memoized (their cache key would have to embed the whole env).
    const identityMemo = new WeakMap<ts.Type, string>()

    // `stable` renders free parameters by NAME instead of the allocation-ordered symbolic
    // id: the ancestry FINGERPRINT feeding the transform cache key must not depend on the
    // order relation queries happened to touch parameters (names are unambiguous within
    // one constraint's own fingerprint); relations keep object-identity ids.
    type IdentityState = { free: boolean, failed: boolean, stable?: boolean }

    const typeIdentityText = (type: ts.Type, env: IdentityEnv, state: IdentityState): string => {
        if ((type.flags & tsInstance.TypeFlags.TypeParameter) !== 0) {
            const entry = env.get(type)

            if (entry !== undefined) {
                // eslint-disable-next-line align-assignments/align-assignments
                state.free ||= entry.free

                return entry.id
            }

            state.free = true

            return state.stable === true ? `param-name:${safeTypeName(type)}` : `param:${symbolicTypeId(type)}`
        }

        // `any` erases whatever was there (e.g. a published generic mixin's `.d.ts`
        // marker erases forwarded parameters to `any`): equal to itself, but a mismatch
        // through it must stay "unknown" — never a manufactured conflict.
        if ((type.flags & tsInstance.TypeFlags.Any) !== 0) {
            state.free = true

            return "any"
        }

        if (env.size === 0) {
            const memoized = identityMemo.get(type)

            if (memoized !== undefined) {
                return memoized
            }
        }

        const target = typeTarget(type)
        const symbol = target.symbol as ts.Symbol | undefined
        const name   = symbol === undefined ? safeTypeName(type) : safeQualifiedName(symbol, type)
        const args   = typeArgumentsOf(type, state)

        const localState: IdentityState = { free: false, failed: false, stable: state.stable }
        const text                      = args.length === 0
            ? `${type.flags}:${name}`
            : `${type.flags}:${name}<${args.map((argument) =>
                typeIdentityText(argument, env, localState)).join(",")}>`

        // eslint-disable-next-line align-assignments/align-assignments
        state.free   ||= localState.free
        state.failed ||= localState.failed

        if (env.size === 0 && !localState.free && !localState.failed) {
            identityMemo.set(type, text)
        }

        return text
    }

    const safeTypeName = (type: ts.Type): string => {
        try {
            return checker.typeToString(type, undefined, tsInstance.TypeFormatFlags.NoTruncation)
        } catch {
            return `opaque:${type.flags}`
        }
    }

    const safeQualifiedName = (symbol: ts.Symbol, type: ts.Type): string => {
        try {
            return checker.getFullyQualifiedName(symbol)
        } catch {
            return safeTypeName(type)
        }
    }

    // User-facing rendering of `type` under the substitution: the declared
    // `GenericBase<T>` with `T -> string` reads `GenericBase<string>` in diagnostics.
    const displayTypeText = (type: ts.Type, env: IdentityEnv): string => {
        if ((type.flags & tsInstance.TypeFlags.TypeParameter) !== 0) {
            return env.get(type)?.display ?? safeTypeName(type)
        }

        const state: IdentityState = { free: false, failed: false }
        const args                 = typeArgumentsOf(type, state)

        if (args.length === 0 || state.failed) {
            return safeTypeName(type)
        }

        const name     = (typeTarget(type).symbol as ts.Symbol | undefined)?.name ?? safeTypeName(type)
        const argTexts = args.map((argument) => displayTypeText(argument, env))

        return name === "Array" && argTexts.length === 1
            ? `${argTexts[0]}[]`
            : `${name}<${argTexts.join(", ")}>`
    }

    const typeArgumentsOf = (type: ts.Type, state: IdentityState): readonly ts.Type[] => {
        if ((type.flags & tsInstance.TypeFlags.Object) === 0 ||
            ((type as ts.ObjectType).objectFlags & tsInstance.ObjectFlags.Reference) === 0
        ) {
            return []
        }

        let arguments_: readonly ts.Type[]

        try {
            arguments_ = checker.getTypeArguments(type as ts.TypeReference)
        } catch {
            state.failed = true

            return []
        }

        // Class references carry an extra polymorphic-`this` argument internally; compare
        // only the declared type parameters.
        const parameterCount = (typeTarget(type) as ts.InterfaceType).typeParameters?.length ?? 0

        return arguments_.slice(0, parameterCount)
    }

    const tryBaseTypes = (target: ts.Type, state: IdentityState): readonly ts.Type[] => {
        if ((target.flags & tsInstance.TypeFlags.Object) === 0) {
            return []
        }

        try {
            return checker.getBaseTypes(target as ts.InterfaceType)
        } catch {
            state.failed = true

            return []
        }
    }

    // The substitution environment for `target`'s DECLARED base types, given the concrete
    // arguments `type` was instantiated with along the current path.
    const childEnvironment = (type: ts.Type, env: IdentityEnv, state: IdentityState): IdentityEnv => {
        const target     = typeTarget(type)
        const parameters = (target as ts.InterfaceType).typeParameters ?? []

        if (parameters.length === 0) {
            return emptyEnv
        }

        const args  = typeArgumentsOf(type, state)
        const child = new Map<ts.Type, EnvEntry>()

        for (let index = 0; index < parameters.length; index++) {
            const argument = args[index]

            if (argument === undefined) {
                child.set(parameters[index]!, {
                    id : state.stable === true
                        ? `param-name:${safeTypeName(parameters[index]!)}`
                        : `param:${symbolicTypeId(parameters[index]!)}`,
                    display : safeTypeName(parameters[index]!),
                    free    : true,
                    node    : undefined
                })
                continue
            }

            const argState: IdentityState = { free: false, failed: false, stable: state.stable }
            const id                      = typeIdentityText(argument, env, argState)

            // eslint-disable-next-line align-assignments/align-assignments
            state.failed ||= argState.failed

            child.set(parameters[index]!, argState.failed ? opaqueEntry() : {
                id,
                display : displayTypeText(argument, env),
                free    : argState.free,
                node    : undefined
            })
        }

        return child
    }

    // Tri-state nominal relation: does `actual` (under `actualEnv`) nominally inherit
    // from `required` (under `requiredEnv`)? Single inheritance means the required class
    // appears at most once on the chain — same target symbol with equal argument
    // identities is "extends" (symbolic parameters equal THEMSELVES), differing CONCRETE
    // arguments are a definite "unrelated", a difference involving any free parameter or
    // guarded failure on the way is "unknown".
    const nominalRelation = (
        actual: ts.Type,
        actualEnv: IdentityEnv,
        required: ts.Type,
        requiredEnv: IdentityEnv
    ): Relation => {
        try {
            const requiredState: IdentityState = { free: false, failed: false }
            const requiredTarget               = typeTarget(required)
            const requiredArgIds               = typeArgumentsOf(required, requiredState)
                .map((argument) => typeIdentityText(argument, requiredEnv, requiredState))

            if (requiredState.failed || requiredTarget.symbol === undefined) {
                return "unknown"
            }

            let sawUnknown = false

            const queue: { type: ts.Type, env: IdentityEnv }[] = [ { type: actual, env: actualEnv } ]
            const seen                                         = new Set<string>()

            for (let cursor = 0; cursor < queue.length; cursor++) {
                const { type, env }            = queue[cursor]!
                const nodeState: IdentityState = { free: false, failed: false }
                const identity                 = typeIdentityText(type, env, nodeState)

                if (seen.has(identity)) {
                    continue
                }

                seen.add(identity)

                const target = typeTarget(type)

                if (target.symbol !== undefined && target.symbol === requiredTarget.symbol) {
                    const argState: IdentityState = { free: false, failed: false }
                    const argIds                  = typeArgumentsOf(type, argState)
                        .map((argument) => typeIdentityText(argument, env, argState))

                    if (argState.failed || argIds.length !== requiredArgIds.length) {
                        return "unknown"
                    }

                    if (argIds.every((argument, index) => argument === requiredArgIds[index])) {
                        return "extends"
                    }

                    return argState.free || requiredState.free ? "unknown" : "unrelated"
                }

                // eslint-disable-next-line align-assignments/align-assignments
                sawUnknown ||= nodeState.free || nodeState.failed

                const ascendState: IdentityState = { free: false, failed: false }
                const childEnv                   = childEnvironment(type, env, ascendState)

                for (const base of tryBaseTypes(target, ascendState)) {
                    queue.push({ type: base, env: childEnv })
                }

                // eslint-disable-next-line align-assignments/align-assignments
                sawUnknown ||= ascendState.free || ascendState.failed
            }

            return sawUnknown ? "unknown" : "unrelated"
        } catch {
            // The outer belt for anything the inner guards missed: a transient tree must
            // degrade to "unknown", never abort Program creation (REVIEW finding 11).
            return "unknown"
        }
    }

    const envKey = (env: IdentityEnv): string =>
        env.size === 0
            ? ""
            : [ ...env ].map(([ parameter, entry ]) => `${symbolicTypeId(parameter)}=${entry.id}`).sort().join(",")

    const createInstance = (constraint: RequiredBaseConstraint, env: IdentityEnv): RequiredBaseInstance => ({
        constraint,
        env,
        baseDisplayName : env.size === 0 ? constraint.baseName : displayInstanceName(constraint, env)
    })

    const displayInstanceName = (constraint: RequiredBaseConstraint, env: IdentityEnv): string => {
        try {
            return displayTypeText(constraint.type, env)
        } catch {
            return constraint.baseName
        }
    }

    const relationCache = new Map<string, Relation>()

    const cachedRelation = (cacheId: string, relate: () => Relation): Relation => {
        const cached = relationCache.get(cacheId)

        if (cached !== undefined) {
            return cached
        }

        const result = relate()

        relationCache.set(cacheId, result)

        return result
    }

    const instanceKey = (instance: RequiredBaseInstance): string =>
        `${instance.constraint.id}@${envKey(instance.env)}`

    const instanceRelation = (actual: RequiredBaseInstance, required: RequiredBaseInstance): Relation =>
        cachedRelation(`${instanceKey(actual)}\0${instanceKey(required)}`, () =>
            nominalRelation(actual.constraint.type, actual.env, required.constraint.type, required.env))

    // Position-free ancestry fingerprint for the transform cache key: a base changing its
    // own `extends` must invalidate transformed consumers even when the mixin declaration
    // itself stayed byte-identical (REVIEW finding 4 keeps POSITIONS out of it).
    const typeAncestryIdentity = (type: ts.Type): string => {
        try {
            const state: IdentityState                         = { free: false, failed: false, stable: true }
            const queue: { type: ts.Type, env: IdentityEnv }[] = [ { type, env: emptyEnv } ]
            const seen                                         = new Set<string>()
            const result: string[]                             = []

            for (let cursor = 0; cursor < queue.length; cursor++) {
                const { type: current, env } = queue[cursor]!
                const identity               = typeIdentityText(current, env, state)

                if (seen.has(identity)) {
                    continue
                }

                seen.add(identity)
                result.push(identity)

                const childEnv = childEnvironment(current, env, state)

                for (const base of tryBaseTypes(typeTarget(current), state)) {
                    queue.push({ type: base, env: childEnv })
                }
            }

            return state.failed ? `${result.join(">")}>!` : result.join(">")
        } catch {
            return "!"
        }
    }

    for (const constraint of constraints) {
        (constraint as { cacheIdentity: string }).cacheIdentity =
            `${constraint.declarationKey.split(":").slice(0, -1).join(":")}:${constraint.mixinName}:` +
            `${constraint.baseName}->${typeAncestryIdentity(constraint.type)}`
    }

    const cacheKey = hasConstraints
        ? constraints.map((constraint) => constraint.cacheIdentity).sort().join("|")
        : ""

    // --- resolution (deduplicated; the ladder exists ONCE — REVIEW finding 9) ---------

    const mergeSelected = (
        accumulated: RequiredBaseResolution,
        next: RequiredBaseResolution
    ): RequiredBaseResolution => {
        if (accumulated.indeterminate || next.indeterminate) {
            return indeterminateResolution
        }

        const left  = accumulated.selected
        const right = next.selected

        if (left === undefined || left === right) {
            return selectedResolution(right ?? left)
        }

        if (right === undefined) {
            return accumulated
        }

        const leftExtendsRight = instanceRelation(left, right)

        if (leftExtendsRight === "extends") {
            return selectedResolution(left)
        }

        const rightExtendsLeft = instanceRelation(right, left)

        if (rightExtendsLeft === "extends") {
            return selectedResolution(right)
        }

        if (leftExtendsRight === "unknown" || rightExtendsLeft === "unknown") {
            return indeterminateResolution
        }

        return { ...emptyResolution, conflict: { left, right } }
    }

    const foldResolutions = (resolutions: Iterable<() => RequiredBaseResolution>): RequiredBaseResolution => {
        let result = emptyResolution

        for (const resolve of resolutions) {
            const resolution = resolve()

            if (resolution.conflict !== undefined || resolution.explicitMismatch !== undefined) {
                return resolution
            }

            result = mergeSelected(result, resolution)

            if (result.conflict !== undefined) {
                return result
            }
        }

        return result
    }

    const applyOwnConstraint = (
        dependencies: RequiredBaseResolution,
        own: RequiredBaseInstance | undefined
    ): RequiredBaseResolution => {
        if (own === undefined ||
            dependencies.conflict !== undefined || dependencies.explicitMismatch !== undefined
        ) {
            return dependencies
        }

        if (dependencies.indeterminate) {
            return indeterminateResolution
        }

        if (dependencies.selected !== undefined) {
            const relation = instanceRelation(own, dependencies.selected)

            if (relation === "unknown") {
                return indeterminateResolution
            }

            if (relation === "unrelated") {
                return {
                    selected         : own,
                    conflict         : undefined,
                    explicitMismatch : { actual: own, required: dependencies.selected },
                    indeterminate    : false
                }
            }
        }

        return selectedResolution(own)
    }

    const resolveWithCycleGuard = <Node>(
        node: Node,
        cache: Map<Node, RequiredBaseResolution>,
        inProgress: Set<Node>,
        resolveDependencies: (node: Node) => RequiredBaseResolution,
        ownConstraint: RequiredBaseInstance | undefined
    ): RequiredBaseResolution => {
        const cached = cache.get(node)

        if (cached !== undefined) {
            return cached
        }

        // A back-edge means a dependency cycle (rejected elsewhere by C3) — break it.
        if (inProgress.has(node)) {
            return emptyResolution
        }

        inProgress.add(node)

        const result = applyOwnConstraint(resolveDependencies(node), ownConstraint)

        inProgress.delete(node)
        cache.set(node, result)

        return result
    }

    const registeredResolutionCache      = new Map<RegisteredMixin, RequiredBaseResolution>()
    const registeredResolutionInProgress = new Set<RegisteredMixin>()
    const programResolutionCache         = new Map<string, RequiredBaseResolution>()
    const programResolutionInProgress    = new Set<string>()

    // The registry-key tier: covers `.d.ts` mixins (whose constraints are env-free by
    // construction — a published marker erases the parameter mapping; the 2026-07 review's
    // cross-package item). In-program mixins resolve through the env-aware program tier below.
    const resolveRegisteredMixin = (mixin: RegisteredMixin): RequiredBaseResolution => {
        if (!hasConstraints) {
            return emptyResolution
        }

        const own = ownConstraintByMixin.get(mixin)

        return resolveWithCycleGuard(
            mixin,
            registeredResolutionCache,
            registeredResolutionInProgress,
            (node) => foldResolutions(node.dependencies.map((dependencyKey) => () => {
                const dependency = registry.get(dependencyKey)

                return dependency === undefined ? emptyResolution : resolveRegisteredMixin(dependency)
            })),
            own === undefined ? undefined : createInstance(own, emptyEnv)
        )
    }

    // Lazy dependency symbol-linking: the mixin-by-symbol map and each mixin's dependency
    // edges materialize on first program-tier resolution, never on program creation.
    let programMixinBySymbol: Map<ts.Symbol, ProgramMixin> | undefined

    const programMixinForSymbol = (symbol: ts.Symbol): ProgramMixin | undefined => {
        if (programMixinBySymbol === undefined) {
            programMixinBySymbol = new Map()

            for (const mixin of programMixins.values()) {
                const name = mixin.declaration.name

                if (name === undefined) {
                    continue
                }

                const mixinSymbol = resolvedSymbolAt(tsInstance, checker, name)

                if (mixinSymbol !== undefined) {
                    programMixinBySymbol.set(mixinSymbol, mixin)
                }
            }
        }

        return programMixinBySymbol.get(symbol)
    }

    const registeredMixinForSymbol = (symbol: ts.Symbol): RegisteredMixin | undefined => {
        const declarationFile = symbol.declarations?.[0]?.getSourceFile()

        return declarationFile === undefined
            ? undefined
            : registry.get(registryKey(declarationFile.fileName, symbol.name))
    }

    const dependencyEdgesOf = (mixin: ProgramMixin): DependencyEdge[] => {
        if (mixin.dependencyEdges !== undefined) {
            return mixin.dependencyEdges
        }

        const edges: DependencyEdge[] = []

        for (const heritageType of mixin.dependencyHeritageTypes) {
            const symbol = resolvedSymbolAt(tsInstance, checker, heritageType.expression)

            if (symbol === undefined) {
                continue
            }

            const programDependency = programMixinForSymbol(symbol)

            if (programDependency !== undefined) {
                edges.push({ program: programDependency, heritage: heritageType })
                continue
            }

            const registeredDependency = registeredMixinForSymbol(symbol)

            if (registeredDependency !== undefined) {
                edges.push({ registered: registeredDependency })
            }
        }

        mixin.dependencyEdges = edges

        return edges
    }

    const declaredParameterType = (parameter: ts.TypeParameterDeclaration): ts.Type | undefined =>
        tryGetType(() => {
            const symbol = checker.getSymbolAtLocation(parameter.name)

            if (symbol === undefined) {
                throw new Error("unresolved type parameter")
            }

            return checker.getDeclaredTypeOfSymbol(symbol)
        })

    // The env for `target` given `implements Target<Args>` at a use site whose own
    // parameters are substituted by `parentEnv`. `parentDeclaration` is the class the
    // heritage appears in — its parameter NAMES key the node-level substitution that
    // keeps entry nodes expressible in the file under expansion (undefined at a top
    // consumer edge: the heritage IS in that file, its nodes are usable as-is).
    const useSiteEnvironment = (
        parentDeclaration: ts.ClassDeclaration | ts.InterfaceDeclaration | undefined,
        parentEnv: IdentityEnv,
        heritage: ts.ExpressionWithTypeArguments | undefined,
        target: ProgramMixin
    ): IdentityEnv => {
        const parameters = target.declaration.typeParameters ?? []

        if (parameters.length === 0) {
            return emptyEnv
        }

        const args = heritage?.typeArguments
        const env  = new Map<ts.Type, EnvEntry>()

        for (let index = 0; index < parameters.length; index++) {
            const parameterType = declaredParameterType(parameters[index]!)

            if (parameterType === undefined) {
                continue
            }

            const argNode = args !== undefined && args.length === parameters.length ? args[index] : undefined
            const argType = argNode === undefined
                ? undefined
                : tryGetType(() => checker.getTypeFromTypeNode(argNode))

            if (argNode === undefined || argType === undefined) {
                env.set(parameterType, opaqueEntry())
                continue
            }

            const state: IdentityState = { free: false, failed: false }
            const id                   = typeIdentityText(argType, parentEnv, state)

            env.set(parameterType, state.failed ? opaqueEntry() : {
                id,
                display : displayTypeText(argType, parentEnv),
                free    : state.free,
                node    : composedArgumentNode(parentDeclaration, parentEnv, argNode)
            })
        }

        return env
    }

    // A node expressing `argNode` in the file under expansion. At a top consumer edge
    // (`parentDeclaration === undefined`) the node already lives there. On a composed
    // edge the node lives in the PARENT mixin's file, so it is transplantable only when
    // every type reference in it is a bare parent parameter with a known node — anything
    // else (a local of the parent's file, a qualified name) yields undefined and the
    // type-level base degrades rather than leak an unresolvable name.
    const composedArgumentNode = (
        parentDeclaration: ts.ClassDeclaration | ts.InterfaceDeclaration | undefined,
        parentEnv: IdentityEnv,
        argNode: ts.TypeNode
    ): ts.TypeNode | undefined => {
        if (parentDeclaration === undefined) {
            return argNode
        }

        const names = collectTypeReferenceNames(tsInstance, argNode)

        if (names === undefined) {
            return undefined
        }

        const substitutions = new Map<string, ts.TypeNode>()

        for (const parameter of parentDeclaration.typeParameters ?? []) {
            if (!names.has(parameter.name.text)) {
                continue
            }

            const parameterType = declaredParameterType(parameter)
            const node          = parameterType === undefined ? undefined : parentEnv.get(parameterType)?.node

            if (node === undefined) {
                return undefined
            }

            substitutions.set(parameter.name.text, node)
        }

        for (const name of names) {
            if (!substitutions.has(name)) {
                return undefined
            }
        }

        return substituteTypeParameterReferences(tsInstance, deepCloneNode(tsInstance, argNode), substitutions)
    }

    // The shared instantiation core: the constraint's heritage type ARGUMENTS rewritten
    // for the consuming site. `raw` when there is nothing to substitute; undefined when a
    // referenced own parameter has no replacement node, or a NON-parameter reference
    // appears in an argument (it would resolve in the MIXIN's scope, not necessarily the
    // consumer's) — the caller degrades instead of leaking an unresolvable name.
    const instantiateHeritageArguments = (
        heritage: ts.ExpressionWithTypeArguments | undefined,
        declaration: ts.ClassDeclaration | ts.InterfaceDeclaration | undefined,
        nodeForParameter: (parameter: ts.TypeParameterDeclaration) => ts.TypeNode | undefined
    ): RequiredBaseInstantiation | undefined => {
        const args = heritage?.typeArguments

        if (heritage === undefined || declaration === undefined || args === undefined || args.length === 0) {
            return { raw: true }
        }

        const parameterNames = new Set((declaration.typeParameters ?? []).map((parameter) => parameter.name.text))
        const referencesOwn  = args.some((argument) => {
            const names = collectTypeReferenceNames(tsInstance, argument)

            return names === undefined || [ ...names ].some((name) => parameterNames.has(name))
        })

        if (!referencesOwn) {
            return { raw: true }
        }

        const substitutions = new Map<string, ts.TypeNode>()

        for (const parameter of declaration.typeParameters ?? []) {
            const node = nodeForParameter(parameter)

            if (node !== undefined) {
                substitutions.set(parameter.name.text, node)
            }
        }

        const typeArguments: ts.TypeNode[] = []

        for (const argument of args) {
            const names = collectTypeReferenceNames(tsInstance, argument)

            if (names === undefined || [ ...names ].some((name) => !substitutions.has(name))) {
                return undefined
            }

            typeArguments.push(substituteTypeParameterReferences(
                tsInstance,
                deepCloneNode(tsInstance, argument),
                substitutions
            ))
        }

        return { raw: false, typeArguments }
    }

    const resolveProgramMixin = (mixin: ProgramMixin, env: IdentityEnv): RequiredBaseResolution =>
        hasConstraints
            ? resolveWithCycleGuard(
                `${mixin.locationKey}@${envKey(env)}`,
                programResolutionCache,
                programResolutionInProgress,
                () => foldResolutions(dependencyEdgesOf(mixin).map((edge) => () =>
                    "registered" in edge
                        ? resolveRegisteredMixin(edge.registered)
                        : resolveProgramMixin(
                            edge.program,
                            useSiteEnvironment(mixin.declaration, env, edge.heritage, edge.program)
                        ))),
                mixin.ownConstraint === undefined ? undefined : createInstance(mixin.ownConstraint, env)
            )
            : emptyResolution

    let programMixinByRegistryKeyMap: Map<string, ProgramMixin> | undefined

    const programMixinByRegistryKey = (key: string): ProgramMixin | undefined => {
        if (programMixinByRegistryKeyMap === undefined) {
            programMixinByRegistryKeyMap = new Map()

            for (const mixin of programMixins.values()) {
                if (mixin.registered !== undefined) {
                    programMixinByRegistryKeyMap.set(
                        registryKey(mixin.registered.fileName, mixin.registered.name),
                        mixin
                    )
                }
            }
        }

        return programMixinByRegistryKeyMap.get(key)
    }

    const resolveRefEntry = (fileName: string, entry: DirectRefEntry): RequiredBaseResolution => {
        const local        = entry.ref.declaration === undefined
            ? undefined
            : programMixins.get(classLocationKey(fileName, entry.ref.declaration.pos))
        const programMixin = local ?? programMixinByRegistryKey(entry.ref.key)

        if (programMixin !== undefined) {
            return resolveProgramMixin(
                programMixin,
                useSiteEnvironment(undefined, emptyEnv, originalHeritageNode(fileName, entry.heritage), programMixin)
            )
        }

        const registered = registry.get(entry.ref.key)

        return registered === undefined ? emptyResolution : resolveRegisteredMixin(registered)
    }

    const resolveDirectRefs = (fileName: string, entries: DirectRefEntry[]): RequiredBaseResolution =>
        hasConstraints
            ? foldResolutions(entries.map((entry) => () => resolveRefEntry(fileName, entry)))
            : emptyResolution

    // The expanders hand us heritage nodes from a PER-CALL CLONE (the compiler host
    // clones the file before transforming — a core invariant), and the checker only
    // answers for nodes of the ORIGINAL program. Positions survive cloning on both
    // planes, so the node is re-anchored by position into the original file before any
    // type query (same pattern as explicitBaseTypeOf). Synthetic heritage (a
    // construction re-expansion) has no position — it degrades to "no use-site args".
    const heritageByPosition = new Map<string, Map<number, ts.ExpressionWithTypeArguments>>()

    const originalHeritageNode = (
        fileName: string,
        heritage: ts.ExpressionWithTypeArguments | undefined
    ): ts.ExpressionWithTypeArguments | undefined => {
        if (heritage === undefined || heritage.pos < 0) {
            return undefined
        }

        const originalFile = sourceFileFor(fileName)

        if (originalFile === undefined) {
            // A directly-driven program (no clone step) — the node IS the original.
            return heritage
        }

        let byPosition = heritageByPosition.get(fileName)

        if (byPosition === undefined) {
            byPosition = new Map()

            const facts = getSourceFileFacts(tsInstance, originalFile, options)

            for (const classFacts of facts.classesByDeclaration.values()) {
                for (const implementsType of classFacts.implementsTypes) {
                    byPosition.set(implementsType.pos, implementsType)
                }

                if (classFacts.extendsType !== undefined) {
                    byPosition.set(classFacts.extendsType.pos, classFacts.extendsType)
                }
            }

            heritageByPosition.set(fileName, byPosition)
        }

        return byPosition.get(heritage.pos)
    }

    const matchesRef = (
        fileName: string,
        ref: ResolvedMixinRef,
        constraint: RequiredBaseConstraint
    ): boolean =>
        constraint.mixin !== undefined
            ? registry.get(ref.key) === constraint.mixin
            : ref.declaration !== undefined &&
                classLocationKey(fileName, ref.declaration.pos) === constraint.declarationKey

    // --- lazy explicit-base validation -------------------------------------------------

    const explicitBaseTypes = new Map<string, ts.Type | undefined>()

    // Re-anchoring by position for the same clone-vs-original reason as
    // `originalHeritageNode` above.
    const explicitBaseTypeOf = (fileName: string, declaration: ts.ClassDeclaration): ts.Type | undefined => {
        const key = classLocationKey(fileName, declaration.pos)

        if (explicitBaseTypes.has(key)) {
            return explicitBaseTypes.get(key)
        }

        const originalFile = sourceFileFor(fileName)
        let heritage: ts.ExpressionWithTypeArguments | undefined

        if (originalFile !== undefined) {
            const originalFacts = getSourceFileFacts(tsInstance, originalFile, options)

            for (const classFacts of originalFacts.classesByDeclaration.values()) {
                if (classFacts.declaration.pos === declaration.pos) {
                    heritage = classFacts.extendsType
                    break
                }
            }
        } else {
            // No original counterpart (a directly-driven program) — the declaration IS
            // the original; a foreign node degrades through the guarded query below.
            heritage = extendsClause(tsInstance, declaration)?.types[0]
        }

        const type = heritage === undefined
            ? undefined
            : tryGetType(() => checker.getTypeAtLocation(heritage))

        explicitBaseTypes.set(key, type)

        return type
    }

    // --- memoized export lookup ---------------------------------------------------------

    const importableExports = new Map<string, boolean>()
    let sourceFilesByNormalizedPath: Map<string, ts.SourceFile> | undefined

    const sourceFileFor = (resolvedFileName: string): ts.SourceFile | undefined => {
        const direct = program.getSourceFile(resolvedFileName)

        if (direct !== undefined) {
            return direct
        }

        if (sourceFilesByNormalizedPath === undefined) {
            sourceFilesByNormalizedPath = new Map(program.getSourceFiles()
                .map((sourceFile) => [ normalizePath(sourceFile.fileName), sourceFile ]))
        }

        return sourceFilesByNormalizedPath.get(normalizePath(resolvedFileName))
    }

    return {
        hasMixins,
        hasConstraints,
        cacheKey,
        resolveDirectRefs,
        resolveRegisteredMixin,
        matchesRef,

        planSelection(fileName, linearized, resolution) {
            if (resolution === undefined || resolution.indeterminate || resolution.conflict !== undefined) {
                return { selectedRef: undefined, plan: undefined }
            }

            if (resolution.selected === undefined) {
                return { selectedRef: undefined, plan: 0 }
            }

            const index = linearized.findIndex((ref) => matchesRef(fileName, ref, resolution.selected!.constraint))

            // A miss is "the owner is not addressable through these refs" — degrade to the
            // runtime scan (plan undefined), NEVER to 0 ("known unconstrained").
            return index === -1
                ? { selectedRef: undefined, plan: undefined }
                : { selectedRef: linearized[index], plan: index + 1 }
        },

        ownsMismatch(fileName, declarationPosition, mismatch) {
            return mismatch.actual.constraint.declarationKey === classLocationKey(fileName, declarationPosition)
        },

        explicitBaseSatisfies(fileName, declaration, required) {
            const actual = explicitBaseTypeOf(fileName, declaration)

            if (actual === undefined) {
                return undefined
            }

            const relation = cachedRelation(
                `explicit:${classLocationKey(fileName, declaration.pos)}\0${instanceKey(required)}`,
                () => nominalRelation(actual, emptyEnv, required.constraint.type, required.env)
            )

            return relation === "unknown" ? undefined : relation === "extends"
        },

        // How the selected base is written into the consuming file: unchanged clone/alias
        // when the declared heritage carries no foreign parameters, an instantiated
        // argument list when the use-site substitution reaches expressible nodes, or
        // undefined — drop the type-level base (never leak a foreign `T`; the members
        // still flow through each mixin's own generated interface, and the plan/runtime
        // side is untouched).
        instantiateBase(instance) {
            const declaration = instance.constraint.declaration

            return instantiateHeritageArguments(
                instance.constraint.heritageNode,
                declaration,
                (parameter) => {
                    const parameterType = declaredParameterType(parameter)

                    return parameterType === undefined ? undefined : instance.env.get(parameterType)?.node
                }
            )
        },

        // The syntactic-tier sibling of `instantiateBase` for an IMPORTED ref's OWN
        // requirement (the checker-authored validation and the no-plan implicit-base
        // fallback): the mixin's published interface heritage instantiated with the
        // DIRECT use-site arguments by parameter NAME — pure syntax, no resolver state.
        importedBaseInstantiation(refKey, useSiteHeritage) {
            const registered = registry.get(refKey)
            const constraint = registered === undefined ? undefined : ownConstraintByMixin.get(registered)

            if (constraint === undefined) {
                return { raw: true }
            }

            const declaration = constraint.declaration
            const parameters  = declaration?.typeParameters ?? []
            const args        = useSiteHeritage?.typeArguments
            const argByName   = args !== undefined && args.length === parameters.length
                ? new Map(parameters.map((parameter, index) => [ parameter.name.text, args[index]! ]))
                : undefined

            return instantiateHeritageArguments(
                constraint.heritageNode,
                declaration,
                (parameter) => argByName?.get(parameter.name.text)
            )
        },

        canImportBase(resolvedFileName, exportedName) {
            const key    = `${resolvedFileName}\0${exportedName}`
            const cached = importableExports.get(key)

            if (cached !== undefined) {
                return cached
            }

            const result = (() => {
                const resolvedSourceFile = sourceFileFor(resolvedFileName)

                if (resolvedSourceFile === undefined) {
                    return false
                }

                const moduleSymbol = resolvedSymbolAt(tsInstance, checker, resolvedSourceFile)

                if (moduleSymbol === undefined) {
                    return false
                }

                try {
                    return checker.getExportsOfModule(moduleSymbol).some((symbol) => symbol.name === exportedName)
                } catch {
                    return false
                }
            })()

            importableExports.set(key, result)

            return result
        }
    }
}

function tryGetType(read: () => ts.Type): ts.Type | undefined {
    try {
        return read()
    } catch {
        // The original program can be a transient source-view tree produced mid-edit. Type
        // queries against an incomplete/dangling declaration must not abort program creation;
        // the next complete edit rebuilds the context and restores the constraint.
        return undefined
    }
}

function resolvedSymbolAt(
    tsInstance: TypeScript,
    checker: ts.TypeChecker,
    node: ts.Node
): ts.Symbol | undefined {
    let symbol: ts.Symbol | undefined

    try {
        symbol = checker.getSymbolAtLocation(node)
    } catch {
        return undefined
    }

    if (symbol === undefined || (symbol.flags & tsInstance.SymbolFlags.Alias) === 0) {
        return symbol
    }

    try {
        return checker.getAliasedSymbol(symbol)
    } catch {
        return undefined
    }
}

function classLocationKey(fileName: string, position: number): string {
    return `${normalizePath(fileName)}:${position}`
}

function typeTarget(type: ts.Type): ts.Type {
    return (type as ts.TypeReference).target ?? type
}
