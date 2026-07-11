import type * as ts from "typescript"

import type { MixinRegistry, RegisteredMixin, ResolvedMixinRef, TransformOptions } from "./model.js"
import { registryKey } from "./model.js"
import { extendsClause } from "./heritage.js"
import { runtimeMixinClassRequiredBaseTypeNode } from "./registry-declaration-file.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import { normalizePath } from "./util.js"
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
//   UNINSTANTIATED bases); a comparison that still reaches a free type parameter is
//   "unknown", which degrades the whole resolution to INDETERMINATE: no diagnostic, no
//   plan — the runtime scan (which sees real constructors) decides precisely.
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
    type           : ts.Type
}

export type RequiredBaseConflict = {
    left  : RequiredBaseConstraint,
    right : RequiredBaseConstraint
}

export type RequiredBaseMismatch = {
    actual   : RequiredBaseConstraint,
    required : RequiredBaseConstraint
}

export type RequiredBaseResolution = {
    selected         : RequiredBaseConstraint | undefined,
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

export type RequiredBaseContext = {
    hasMixins              : boolean,
    hasConstraints         : boolean,
    cacheKey               : string,
    resolveMixinKeys       : (keys: string[]) => RequiredBaseResolution,
    resolveRefs            : (fileName: string, refs: ResolvedMixinRef[]) => RequiredBaseResolution,
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
        required: RequiredBaseConstraint
    ) => boolean | undefined,
    canImportBase : (resolvedFileName: string, exportedName: string) => boolean
}

type ProgramMixin = {
    locationKey             : string,
    declaration             : ts.ClassDeclaration,
    registered              : RegisteredMixin | undefined,
    ownConstraint           : RequiredBaseConstraint | undefined,
    dependencyHeritageTypes : ts.ExpressionWithTypeArguments[],
    dependencies            : ProgramMixin[] | undefined
}

type Relation = "extends" | "unrelated" | "unknown"

// Identity substitution: type-PARAMETER object → the identity text it is instantiated
// with along the current ancestry path. Keyed by the ts.Type object (stable within one
// checker), so same-named parameters of different declarations never collide.
type IdentityEnv = ReadonlyMap<ts.Type, string>

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

const selectedResolution = (selected: RequiredBaseConstraint | undefined): RequiredBaseResolution =>
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
    for (const sourceFile of program.getSourceFiles()) {
        if (!sourceFile.text.includes(options.packageName)) {
            continue
        }

        if (sourceFile.isDeclarationFile) {
            collectDeclarationConstraints(tsInstance, checker, sourceFile, registry, ownConstraintByMixin)
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
                    type           : baseType
                }

            programMixins.set(location, {
                locationKey             : location,
                declaration             : classFacts.declaration,
                registered,
                ownConstraint           : constraint,
                dependencyHeritageTypes : classFacts.implementsTypes,
                dependencies            : undefined
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

    // Memo for env-free, free-parameter-free identities (the common case: concrete
    // constraint types and their ancestries). Env-dependent identities are cheap enough
    // and not memoized (their cache key would have to embed the whole env).
    const identityMemo = new WeakMap<ts.Type, string>()

    type IdentityState = { free: boolean, failed: boolean }

    const typeIdentityText = (type: ts.Type, env: IdentityEnv, state: IdentityState): string => {
        if ((type.flags & tsInstance.TypeFlags.TypeParameter) !== 0) {
            const substituted = env.get(type)

            if (substituted !== undefined) {
                return substituted
            }

            state.free = true

            return `free-parameter:${safeTypeName(type)}`
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

        const localState: IdentityState = { free: false, failed: false }
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
        const child = new Map<ts.Type, string>()

        for (let index = 0; index < parameters.length; index++) {
            const argument = args[index]

            child.set(
                parameters[index]!,
                argument === undefined
                    ? typeIdentityText(parameters[index]!, emptyEnv, state)
                    : typeIdentityText(argument, env, state)
            )
        }

        return child
    }

    // Tri-state nominal relation: does `actual` (a concrete constraint type) nominally
    // inherit from `required`? Single inheritance means the required class appears at
    // most once on the chain — same target symbol with different CONCRETE arguments is a
    // definite "unrelated", any free parameter or guarded failure on the way is "unknown".
    const nominalRelation = (actual: ts.Type, required: ts.Type): Relation => {
        try {
            const requiredState: IdentityState = { free: false, failed: false }
            const requiredTarget               = typeTarget(required)
            const requiredArgIds               = typeArgumentsOf(required, requiredState)
                .map((argument) => typeIdentityText(argument, emptyEnv, requiredState))

            if (actual === required) {
                return "extends"
            }

            if (requiredState.free || requiredState.failed) {
                return "unknown"
            }

            let sawUnknown = false

            const queue: { type: ts.Type, env: IdentityEnv }[] = [ { type: actual, env: emptyEnv } ]
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

                    if (argState.free || argState.failed ||
                        argIds.length !== requiredArgIds.length
                    ) {
                        return "unknown"
                    }

                    return argIds.every((argument, index) => argument === requiredArgIds[index])
                        ? "extends"
                        : "unrelated"
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

    const relationCache = new Map<string, Relation>()

    const cachedRelation = (cacheId: string, actual: ts.Type, required: ts.Type): Relation => {
        const cached = relationCache.get(cacheId)

        if (cached !== undefined) {
            return cached
        }

        const result = nominalRelation(actual, required)

        relationCache.set(cacheId, result)

        return result
    }

    const constraintRelation = (actual: RequiredBaseConstraint, required: RequiredBaseConstraint): Relation =>
        cachedRelation(`${actual.id}\0${required.id}`, actual.type, required.type)

    // Position-free ancestry fingerprint for the transform cache key: a base changing its
    // own `extends` must invalidate transformed consumers even when the mixin declaration
    // itself stayed byte-identical (REVIEW finding 4 keeps POSITIONS out of it).
    const typeAncestryIdentity = (type: ts.Type): string => {
        try {
            const state: IdentityState                         = { free: false, failed: false }
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

        const leftExtendsRight = constraintRelation(left, right)

        if (leftExtendsRight === "extends") {
            return selectedResolution(left)
        }

        const rightExtendsLeft = constraintRelation(right, left)

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
        own: RequiredBaseConstraint | undefined
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
            const relation = constraintRelation(own, dependencies.selected)

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
        ownConstraint: RequiredBaseConstraint | undefined
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

    const resolutionCache             = new Map<RegisteredMixin, RequiredBaseResolution>()
    const resolutionInProgress        = new Set<RegisteredMixin>()
    const programResolutionCache      = new Map<ProgramMixin, RequiredBaseResolution>()
    const programResolutionInProgress = new Set<ProgramMixin>()

    const resolveRegisteredMixin = (mixin: RegisteredMixin): RequiredBaseResolution =>
        hasConstraints
            ? resolveWithCycleGuard(
                mixin,
                resolutionCache,
                resolutionInProgress,
                (node) => foldResolutions(node.dependencies.map((dependencyKey) => () => {
                    const dependency = registry.get(dependencyKey)

                    return dependency === undefined ? emptyResolution : resolveRegisteredMixin(dependency)
                })),
                ownConstraintByMixin.get(mixin)
            )
            : emptyResolution

    // Lazy dependency symbol-linking: the mixin-by-symbol map and each mixin's dependency
    // list materialize on first program-tier resolution, never on program creation.
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

    const programDependenciesOf = (mixin: ProgramMixin): ProgramMixin[] => {
        if (mixin.dependencies !== undefined) {
            return mixin.dependencies
        }

        const dependencies: ProgramMixin[] = []

        for (const heritageType of mixin.dependencyHeritageTypes) {
            const symbol = resolvedSymbolAt(tsInstance, checker, heritageType.expression)

            if (symbol === undefined) {
                continue
            }

            const dependency = programMixinForSymbol(symbol)

            if (dependency !== undefined) {
                dependencies.push(dependency)
            }
        }

        mixin.dependencies = dependencies

        return dependencies
    }

    const resolveProgramMixin = (mixin: ProgramMixin): RequiredBaseResolution => {
        if (mixin.registered !== undefined) {
            return resolveRegisteredMixin(mixin.registered)
        }

        return hasConstraints
            ? resolveWithCycleGuard(
                mixin,
                programResolutionCache,
                programResolutionInProgress,
                (node) => foldResolutions(programDependenciesOf(node).map((dependency) => () =>
                    resolveProgramMixin(dependency))),
                mixin.ownConstraint
            )
            : emptyResolution
    }

    const resolveMixinKeys = (keys: string[]): RequiredBaseResolution =>
        hasConstraints
            ? foldResolutions(keys.map((key) => () => {
                const mixin = registry.get(key)

                return mixin === undefined ? emptyResolution : resolveRegisteredMixin(mixin)
            }))
            : emptyResolution

    const resolveRefResolution = (fileName: string, ref: ResolvedMixinRef): RequiredBaseResolution => {
        const programMixin = ref.declaration === undefined
            ? undefined
            : programMixins.get(classLocationKey(fileName, ref.declaration.pos))

        if (programMixin !== undefined) {
            return resolveProgramMixin(programMixin)
        }

        const registered = registry.get(ref.key)

        return registered === undefined ? emptyResolution : resolveRegisteredMixin(registered)
    }

    const resolveRefs = (fileName: string, refs: ResolvedMixinRef[]): RequiredBaseResolution =>
        hasConstraints
            ? foldResolutions(refs.map((ref) => () => resolveRefResolution(fileName, ref)))
            : emptyResolution

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

    // The expanders hand us a declaration from a PER-CALL CLONE (the compiler host clones
    // the file before transforming — a core invariant), and the checker only answers for
    // nodes of the ORIGINAL program. Positions survive cloning on both planes, so the
    // declaration is re-anchored by position into the original file before the type query.
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
        resolveMixinKeys,
        resolveRefs,
        resolveRegisteredMixin,
        matchesRef,

        planSelection(fileName, linearized, resolution) {
            if (resolution === undefined || resolution.indeterminate || resolution.conflict !== undefined) {
                return { selectedRef: undefined, plan: undefined }
            }

            if (resolution.selected === undefined) {
                return { selectedRef: undefined, plan: 0 }
            }

            const index = linearized.findIndex((ref) => matchesRef(fileName, ref, resolution.selected!))

            // A miss is "the owner is not addressable through these refs" — degrade to the
            // runtime scan (plan undefined), NEVER to 0 ("known unconstrained").
            return index === -1
                ? { selectedRef: undefined, plan: undefined }
                : { selectedRef: linearized[index], plan: index + 1 }
        },

        ownsMismatch(fileName, declarationPosition, mismatch) {
            return mismatch.actual.declarationKey === classLocationKey(fileName, declarationPosition)
        },

        explicitBaseSatisfies(fileName, declaration, required) {
            const actual = explicitBaseTypeOf(fileName, declaration)

            if (actual === undefined) {
                return undefined
            }

            const relation = cachedRelation(
                `explicit:${classLocationKey(fileName, declaration.pos)}\0${required.id}`,
                actual,
                required.type
            )

            return relation === "unknown" ? undefined : relation === "extends"
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

function collectDeclarationConstraints(
    tsInstance: TypeScript,
    checker: ts.TypeChecker,
    sourceFile: ts.SourceFile,
    registry: MixinRegistry,
    constraints: Map<RegisteredMixin, RequiredBaseConstraint>
): void {
    for (const statement of sourceFile.statements) {
        if (!tsInstance.isVariableStatement(statement)) {
            continue
        }

        for (const declaration of statement.declarationList.declarations) {
            if (!tsInstance.isIdentifier(declaration.name) || declaration.type === undefined) {
                continue
            }

            const requiredBase = runtimeMixinClassRequiredBaseTypeNode(tsInstance, declaration.type)

            if (requiredBase === undefined || requiredBase.kind === tsInstance.SyntaxKind.ObjectKeyword) {
                continue
            }

            const registered = registry.get(registryKey(sourceFile.fileName, declaration.name.text))

            if (registered === undefined) {
                continue
            }

            const baseType = tryGetType(() => checker.getTypeFromTypeNode(requiredBase))

            if (baseType === undefined) {
                continue
            }

            const location = classLocationKey(sourceFile.fileName, declaration.pos)

            constraints.set(registered, {
                id             : location,
                declarationKey : location,
                cacheIdentity  : "",
                mixin          : registered,
                mixinName      : declaration.name.text,
                baseName       : requiredBase.getText(sourceFile),
                type           : baseType
            })
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
