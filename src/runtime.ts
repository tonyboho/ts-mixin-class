import { C3LinearizationError, mergeC3Linearizations } from "./c3-linearization.js"
import { base, factory, requirements, type AnyConstructor, type ClassStatics, type MixinApplication, type MixinFactory } from "./base.js"
export {
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
    & ClassStatics<ReturnType<Factory>>
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
    requiredBase: AnyConstructor<any> = Object
): RuntimeMixinClassValue {
    const requirementList                = [ ...mixinRequirements ]
    const requirementLinearization       = linearizeRuntimeRequirements(requirementList)
    const canonicalBase                  = applyRuntimeMixins(requiredBase, requirementLinearization.slice().reverse())
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
