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

type RuntimeMixinClassValue = AnyConstructor<any> & RuntimeMixinClass & {
    readonly mix : <Base extends AnyConstructor<any>>(base: Base) => AnyConstructor<any>
}

type RuntimeMixinMetadata = {
    factory       : MixinFactory,
    requirements  : RuntimeMixinClassValue[],
    requiredBase  : AnyConstructor<any>,
    linearization : RuntimeMixinClassValue[] | undefined,
    applications  : WeakMap<AnyConstructor<any>, AnyConstructor<any>>
}

const runtimeMixinMetadata = new WeakMap<RuntimeMixinClassValue, RuntimeMixinMetadata>()
const appliedMixinClasses  = new WeakMap<AnyConstructor<any>, Set<RuntimeMixinClassValue>>()

export function mixin(..._args: unknown[]): (..._decoratorArgs: unknown[]) => void {
    return () => {}
}

export function defineMixinClass(
    name: string,
    mixinFactory: MixinFactory,
    mixinRequirements: readonly RuntimeMixinClassValue[] = [],
    requiredBase: AnyConstructor<any> = Object
): RuntimeMixinClassValue {
    const requirementList          = [ ...mixinRequirements ]
    const requirementLinearization = linearizeRuntimeRequirements(requirementList)
    const canonicalBase            = applyRuntimeMixins(requiredBase, requirementLinearization.slice().reverse())
    const mixinClass               = mixinFactory(canonicalBase) as RuntimeMixinClassValue
    const applications             = new WeakMap<AnyConstructor<any>, AnyConstructor<any>>()

    applications.set(canonicalBase, mixinClass)

    runtimeMixinMetadata.set(mixinClass, {
        factory       : mixinFactory,
        requirements  : requirementList,
        requiredBase,
        linearization : [ mixinClass, ...requirementLinearization ],
        applications
    })

    Object.defineProperty(mixinClass, factory, { value: mixinFactory })
    Object.defineProperty(mixinClass, requirements, { value: requirementList })
    Object.defineProperty(mixinClass, base, { value: requiredBase })
    Object.defineProperty(mixinClass, "mix", {
        value(runtimeBase: AnyConstructor<any>) {
            return mixinChain(runtimeBase, mixinClass)
        }
    })
    Object.defineProperty(mixinClass, Symbol.hasInstance, {
        value(instance: unknown) {
            return hasRuntimeMixinInstance(instance, mixinClass)
        }
    })

    setClassName(mixinClass, name)
    registerAppliedMixins(mixinClass, [ mixinClass, ...requirementLinearization ])

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
    const metadata = runtimeMetadataOf(mixinClass)
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
    setClassName(appliedClass, mixinClass.name)
    registerAppliedMixins(appliedClass, [ mixinClass, ...linearizeRuntimeMixin(mixinClass).slice(1) ])

    return appliedClass
}

function linearizeRuntimeMixin(mixinClass: RuntimeMixinClassValue): RuntimeMixinClassValue[] {
    const metadata = runtimeMetadataOf(mixinClass)

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

function runtimeMetadataOf(mixinClass: RuntimeMixinClassValue): RuntimeMixinMetadata {
    const metadata = runtimeMixinMetadata.get(mixinClass)

    if (metadata === undefined) {
        throw new Error(`Class ${mixinClass.name || "<anonymous>"} is not a registered mixin class`)
    }

    return metadata
}

function classExtends(base: AnyConstructor<any>, requiredBase: AnyConstructor<any>): boolean {
    return requiredBase === Object ||
        base === requiredBase ||
        requiredBase.prototype.isPrototypeOf(base.prototype)
}

function registerAppliedMixins(
    appliedClass: AnyConstructor<any>,
    mixins: readonly RuntimeMixinClassValue[]
): void {
    const inherited = appliedMixinClasses.get(Object.getPrototypeOf(appliedClass)) ?? new Set<RuntimeMixinClassValue>()
    const applied   = new Set<RuntimeMixinClassValue>(inherited)

    for (const mixinClass of mixins) {
        applied.add(mixinClass)
    }

    appliedMixinClasses.set(appliedClass, applied)
}

function hasRuntimeMixinInstance(instance: unknown, mixinClass: RuntimeMixinClassValue): boolean {
    if (instance === null || typeof instance !== "object" && typeof instance !== "function") {
        return false
    }

    let constructor = (instance as { constructor?: unknown }).constructor

    while (typeof constructor === "function") {
        if (appliedMixinClasses.get(constructor as AnyConstructor<any>)?.has(mixinClass)) {
            return true
        }

        constructor = Object.getPrototypeOf(constructor)
    }

    return false
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
