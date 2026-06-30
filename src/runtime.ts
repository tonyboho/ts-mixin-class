import { C3LinearizationError, mergeC3Linearizations } from "./c3-linearization.js"
import { Empty, base, factory, requirements, type AnyConstructor, type ClassStatics, type MixinApplication, type MixinFactory } from "./base.js"
export {
    Empty,
    base,
    factory,
    requirements,
    type AnyConstructor,
    type ClassStatics,
    type MixinApplication,
    type MixinFactory
} from "./base.js"

export type StaticNeverConflictKeys<Left, Right> = {
    [Key in Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]:
        [ ClassStatics<Left>[Key] & ClassStatics<Right>[Key] ] extends [ never ]
            ? Key
            : never
}[Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]

export type StaticStrictConflictKeys<Left, Right> = {
    [Key in Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]:
        [ ClassStatics<Left>[Key] ] extends [ ClassStatics<Right>[Key] ]
            ? [ ClassStatics<Right>[Key] ] extends [ ClassStatics<Left>[Key] ]
                ? never
                : Key
            : Key
}[Extract<keyof ClassStatics<Left>, keyof ClassStatics<Right>>]

export type RuntimeMixinClass<RequiredBase extends object = object> = {
    readonly [factory]      : MixinFactory,
    readonly [requirements] : readonly RuntimeMixinClass[],
    readonly [base]         : AnyConstructor<RequiredBase>
}

// Factored static type of a non-generic mixin class value. The transformer emits
// `... as unknown as MixinClassValue<X, typeof __X$mixin> & RuntimeMixinClass`
// instead of inlining the constructor + ClassStatics + `mix` intersection at
// every mixin (which dominated emitted output). Must stay structurally identical
// to that inline form so inference, declaration emit, and manual `.mix()` are
// unchanged. Generic mixins keep the inline form (their `mix`/constructor capture
// the mixin's own type parameters, which a fixed alias cannot express).
export type MixinClassValue<
    Instance extends object,
    Factory extends (...args: any[]) => any,
    RequiredBase extends object = any
> =
    (new (...args: any[]) => Instance)
    & ConstructionMixinClassValue<Instance, Factory, RequiredBase>

// `MixinClassValue` WITHOUT the permissive bare construct signature — the value form for a
// construction (Base-deriving) mixin, whose direct `new` is poisoned with a brand so it can only
// be built through the generated static `.new(...)`. The statics and `.mix` are unchanged.
export type ConstructionMixinClassValue<
    Instance extends object,
    Factory extends (...args: any[]) => any,
    RequiredBase extends object = any
> =
    ClassStatics<ReturnType<Factory>>
    & {
        readonly mix: <Base extends AnyConstructor<RequiredBase>>(base: Base) =>
            MixinApplication<Base, Instance, ReturnType<Factory>>
    }

// Internal per-mixin metadata is stored directly on the mixin constructor under this
// symbol, alongside the factory/requirements/base markers — so there is no external map to
// consult, and the metadata is collected together with the constructor.
const mixinMetadata = Symbol("mixinMetadata")

// Public value type (the transformer emits values structurally matching this, and the
// exported `defineMixinClass` / `mixinChain` take it). It must NOT mention the internal
// metadata symbol, or emitted values would stop being assignable to it.
type RuntimeMixinClassValue = AnyConstructor<any> & RuntimeMixinClass & {
    readonly mix : <Base extends AnyConstructor<any>>(base: Base) => AnyConstructor<any>
}

// Internal view of a registered mixin: the public value plus the metadata attached to its
// constructor. Used only where the runtime reads its own metadata back.
type RegisteredMixinClass = RuntimeMixinClassValue & {
    readonly [mixinMetadata] : RuntimeMixinMetadata
}

type RuntimeMixinMetadata = {
    factory       : MixinFactory,
    requirements  : RuntimeMixinClassValue[],
    requiredBase  : AnyConstructor<any>,
    linearization : RuntimeMixinClassValue[] | undefined,
    applications  : WeakMap<AnyConstructor<any>, AnyConstructor<any>>,
    marker        : symbol
}

export function mixin(..._args: unknown[]): (..._decoratorArgs: unknown[]) => void {
    return () => {}
}

export function defineMixinClass(
    name: string,
    mixinFactory: MixinFactory,
    mixinRequirements: readonly RuntimeMixinClassValue[] = [],
    // The mixin's requirement CONSTRAINT: every base it is applied over must `classExtends` this
    // (see `applyRuntimeMixin`). `Object` means "no constraint" — a base-less mixin composes over
    // any base. This is distinct from the standalone SEED below: the constraint governs consumers,
    // the seed only roots the mixin's own `new`-able canonical class.
    requiredBase: AnyConstructor<any> = Object,
    // Approach (B): a compile-time merge plan that reconstructs this mixin's requirement
    // linearization by slicing its dependencies' already-materialized linearizations,
    // skipping the runtime C3 merge. Optional: dependency-free mixins need no plan, and a
    // conflicting requirement set has none -- both fall back to the C3 path below.
    linearizationPlan?: LinearizationPlan,
    // What to do with the plan, chosen by the compiler from the build environment (see
    // LinearizationMode). Default (undefined) replays it.
    linearizationMode?: LinearizationMode
): RuntimeMixinClassValue {
    const requirementList          = [ ...mixinRequirements ]
    const requirementLinearization = resolveRequirementLinearization(
        name, requirementList, linearizationPlan, linearizationMode
    )
    // Seed the mixin's own canonical (standalone, `new`-able) class from `Empty` when no required
    // base was given, so a base-less mixin instance descends from the library-owned `Empty` rather
    // than a bare `Object`. This is a runtime filler only — `Empty` is never stored as the
    // requirement `requiredBase` (which stays `Object`), so it imposes no constraint on consumers.
    const seedBase                       = requiredBase === Object ? Empty : requiredBase
    const canonicalBase                  = applyRuntimeMixins(seedBase, requirementLinearization.slice().reverse())
    const mixinClass                     = mixinFactory(canonicalBase) as RuntimeMixinClassValue
    const applications                   = new WeakMap<AnyConstructor<any>, AnyConstructor<any>>()
    const marker                         = Symbol(name)
    const metadata: RuntimeMixinMetadata = {
        factory       : mixinFactory,
        requirements  : requirementList,
        requiredBase,
        linearization : [ mixinClass, ...requirementLinearization ],
        applications,
        marker
    }

    applications.set(canonicalBase, mixinClass)
    markRuntimeMixin(mixinClass, marker)

    Object.defineProperty(mixinClass, mixinMetadata, { value: metadata })
    Object.defineProperty(mixinClass, factory, { value: mixinFactory })
    Object.defineProperty(mixinClass, requirements, { value: requirementList })
    Object.defineProperty(mixinClass, base, { value: requiredBase })
    Object.defineProperty(mixinClass, "mix", {
        value(runtimeBase: AnyConstructor<any>) {
            return mixinChain(runtimeBase, mixinClass)
        }
    })
    Object.defineProperty(mixinClass, Symbol.hasInstance, {
        // The mixin's own unique marker is captured directly here and published on the
        // prototype of every class it is applied to (see markRuntimeMixin); an instance
        // reaches the markers of its whole linearized chain through its prototype chain,
        // so this is a native lookup with no metadata indirection.
        value(instance: unknown): boolean {
            return Boolean(instance && (instance as Record<symbol, unknown>)[marker])
        }
    })

    setClassName(mixinClass, name)

    return mixinClass
}

export function mixinChain<Base extends AnyConstructor<any>>(
    base: Base,
    ...mixins: RuntimeMixinClassValue[]
): AnyConstructor<any> {
    return applyRuntimeMixins(base, linearizeRuntimeRequirements(mixins).slice().reverse())
}

// Approach (B) for the consumer site: apply `mixins` to `base` using a compile-time
// merge plan instead of the runtime C3 merge `mixinChain` runs. `mixins` is an array
// (not variadic) so the trailing plan stays unambiguous; `mixinChain` keeps the
// variadic, plan-free signature for manual use and older emitted consumers.
export function mixinChainLinearized<Base extends AnyConstructor<any>>(
    base: Base,
    mixins: readonly RuntimeMixinClassValue[],
    linearizationPlan: LinearizationPlan,
    linearizationMode?: LinearizationMode
): AnyConstructor<any> {
    const linearization = resolveRequirementLinearization(
        "mixinChain", [ ...mixins ], linearizationPlan, linearizationMode
    )

    return applyRuntimeMixins(base, linearization.slice().reverse())
}

// A compile-time merge plan: a list of contiguous slices over the merge inputs. Each
// slice `[source, offset, length]` copies `length` elements from input sequence `source`
// starting at `offset`. The inputs are a requirement list's merge sources (see
// `requirementMergeSources`), so replaying the plan reproduces `mergeC3Linearizations`
// over those sources without the good-head search.
export type LinearizationSlice = readonly [ source: number, offset: number, length: number ]
export type LinearizationPlan = readonly LinearizationSlice[]

// What the runtime does with an emitted plan. The compiler picks one from the build
// environment and emits it as a trailing argument; the runtime never reads any environment
// itself, so it stays cross-platform. Three modes:
//   "verify"  -- replay, then cross-check against C3 and throw on a mismatch (the default; dev safety).
//   "replay"  -- replay the plan as-is, no cross-check (production).
//   "c3"      -- ignore the plan and run C3 (escape hatch; the plan is still emitted).
// A missing mode (manual callers) is treated as "replay".
export type LinearizationMode = "verify" | "replay" | "c3"

function resolveRequirementLinearization(
    name: string,
    requirements: readonly RuntimeMixinClassValue[],
    linearizationPlan: LinearizationPlan | undefined,
    linearizationMode: LinearizationMode | undefined
): RuntimeMixinClassValue[] {
    if (linearizationPlan === undefined || linearizationMode === "c3") {
        return linearizeRuntimeRequirements([ ...requirements ])
    }

    const replayed = replayLinearizationPlan(linearizationPlan, requirementMergeSources(requirements))

    if (linearizationMode === "verify") {
        assertLinearizationMatches(name, replayed, linearizeRuntimeRequirements([ ...requirements ]))
    }

    return replayed
}

// The C3 merge inputs for a requirement list: each requirement's full linearization,
// then the direct requirement list itself -- identical to what
// `linearizeRuntimeRequirements` feeds `mergeC3Linearizations`, so a plan derived against
// these inputs at compile time replays correctly at run time.
function requirementMergeSources(
    requirements: readonly RuntimeMixinClassValue[]
): RuntimeMixinClassValue[][] {
    return [
        ...requirements.map((mixinClass) => linearizeRuntimeMixin(mixinClass)),
        [ ...requirements ]
    ]
}

function replayLinearizationPlan(
    plan: LinearizationPlan,
    sources: readonly (readonly RuntimeMixinClassValue[])[]
): RuntimeMixinClassValue[] {
    const result: RuntimeMixinClassValue[] = []

    for (const [ source, offset, length ] of plan) {
        const sequence = sources[source]

        if (sequence === undefined) {
            throw new Error(`Linearization plan references missing source ${source}`)
        }

        for (let index = offset; index < offset + length; index++) {
            result.push(sequence[index]!)
        }
    }

    return result
}

function assertLinearizationMatches(
    name: string,
    replayed: readonly RuntimeMixinClassValue[],
    reference: readonly RuntimeMixinClassValue[]
): void {
    const matches = replayed.length === reference.length &&
        replayed.every((value, index) => value === reference[index])

    if (!matches) {
        const show = (sequence: readonly RuntimeMixinClassValue[]) =>
            sequence.map((mixinClass) => mixinClass.name || "<anonymous>").join(", ")

        throw new Error(
            `Precomputed linearization for ${name} differs from the C3 result: ` +
            `replay [${show(replayed)}] vs C3 [${show(reference)}]`
        )
    }
}

function applyRuntimeMixins(
    base: AnyConstructor<any>,
    mixins: readonly RuntimeMixinClassValue[]
): AnyConstructor<any> {
    let current = base

    for (const mixinClass of mixins) {
        current = applyRuntimeMixin(current, mixinClass)
    }

    return current
}

function applyRuntimeMixin(
    base: AnyConstructor<any>,
    mixinClass: RuntimeMixinClassValue
): AnyConstructor<any> {
    const metadata = (mixinClass as RegisteredMixinClass)[mixinMetadata]
    const cached   = metadata.applications.get(base)

    if (!classExtends(base, metadata.requiredBase)) {
        throw new Error(
            `Mixin class ${mixinClass.name || "<anonymous>"} requires base ` +
            `${metadata.requiredBase.name || "<anonymous>"}`
        )
    }

    if (cached !== undefined) {
        return cached
    }

    const appliedClass = metadata.factory(base)

    metadata.applications.set(base, appliedClass)
    markRuntimeMixin(appliedClass, metadata.marker)
    setClassName(appliedClass, mixinClass.name)

    return appliedClass
}

function linearizeRuntimeMixin(mixinClass: RuntimeMixinClassValue): RuntimeMixinClassValue[] {
    const metadata = (mixinClass as RegisteredMixinClass)[mixinMetadata]

    if (metadata.linearization !== undefined) {
        return metadata.linearization
    }

    metadata.linearization = [
        mixinClass,
        ...linearizeRuntimeRequirements(metadata.requirements)
    ]

    return metadata.linearization
}

function linearizeRuntimeRequirements(
    mixins: readonly RuntimeMixinClassValue[]
): RuntimeMixinClassValue[] {
    if (mixins.length === 0) {
        return []
    }

    return mergeRuntimeLinearizations([
        ...mixins.map((mixinClass) => [ ...linearizeRuntimeMixin(mixinClass) ]),
        [ ...mixins ]
    ])
}

function mergeRuntimeLinearizations(sequences: RuntimeMixinClassValue[][]): RuntimeMixinClassValue[] {
    try {
        return mergeC3Linearizations(sequences)
    }
    catch (error) {
        if (error instanceof C3LinearizationError) {
            throw new Error("Cannot linearize mixin classes: inconsistent requirements")
        }

        throw error
    }
}

function classExtends(base: AnyConstructor<any>, requiredBase: AnyConstructor<any>): boolean {
    return requiredBase === Object ||
        base === requiredBase ||
        requiredBase.prototype.isPrototypeOf(base.prototype)
}

// Publish a mixin's unique identity marker on an applied class's prototype, so any
// instance of that class (or a subclass) answers `instance[marker] === true` through the
// prototype chain.
function markRuntimeMixin(appliedClass: AnyConstructor<any>, marker: symbol): void {
    ;(appliedClass.prototype as Record<symbol, unknown>)[marker] = true
}

function setClassName(classConstructor: AnyConstructor<any>, name: string): void {
    if (name.length === 0) {
        return
    }

    Object.defineProperty(classConstructor, "name", {
        configurable : true,
        value        : name
    })
}
