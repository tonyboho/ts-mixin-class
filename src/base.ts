export type AnyConstructor<T extends object = object> = new (...args: any[]) => T

export type ClassStatics<C> = Omit<C, "prototype">

// NB an emitted factory does NOT satisfy this type nominally — its parameter is annotated with
// the mixin's precise base (`AnyConstructor<Req & Deps> & ClassStatics<typeof Req> & …`, see
// `createBaseParameter`), narrower than this slot under `strictFunctionTypes` parameter
// contravariance. The emit bridges it with the `as unknown as MixinFactory` cast on the
// `defineMixinClass` argument; the per-definition annotation carries the real checking.
export type MixinFactory = (base: AnyConstructor<any>) => AnyConstructor<any>

export type MixinApplication<
    Base extends AnyConstructor<any>,
    MixinInstance extends object,
    MixinStatics
> =
    (new (...args: ConstructorParameters<Base>) => InstanceType<Base> & MixinInstance) &
    ClassStatics<Base> &
    ClassStatics<MixinStatics>

// The result type of `M.mix(B)`, as a WRITTEN annotation — for the external (non-transformer)
// consumer under `isolatedDeclarations`, whose exported class over a manual `.mix` hits the
// option's own TS9021 (expression heritage). The supported recipe hoists the application into
// an annotated const (checked, unlike an as-assertion):
//
//     const AppBase: Mix<typeof Logger, typeof Custom> = Logger.mix(Custom)
//     export class App extends AppBase {}
//
// STRUCTURAL on purpose: a conditional-infer formulation (`M extends { mix: (base: B) =>
// infer R } ? R : never`) silently degrades to an `any` instance side — inference from the
// generic `mix` signature falls back to its constraint — and stops checking anything.
// `ClassStatics` drops `prototype` and every construct signature (a mapped type keeps only
// properties), and the framework's own `mix` + runtime marker symbols are omitted, leaving
// exactly the statics an application inherits.
export type Mix<
    M extends AnyConstructor<object>,
    B extends AnyConstructor<object>
> = MixinApplication<
    B,
    InstanceType<M>,
    Omit<ClassStatics<M>, "mix" | typeof factory | typeof requirements | typeof base>
>

export const factory: unique symbol = Symbol.for("ts-mixin-class.factory")
export const requirements: unique symbol = Symbol.for("ts-mixin-class.requirements")
export const base: unique symbol = Symbol.for("ts-mixin-class.base")

// The default base for a `@mixin` declared without an `extends` clause. A real, named,
// library-owned class (rather than the bare `Object`) so every base-less mixin instance shares
// one common, identifiable ancestor — a stable shape and a single anchor for `instanceof` and
// any future cross-mixin protocol. `Empty` itself descends from `Object`, so nothing is lost.
export class Empty {
}

export class Base {
    // `props` is `unknown` (the top type) so any subclass - including a `@mixin` - can
    // override `initialize` with a STRICTER `<ClassName>Config` parameter
    // (`override initialize(config: ModelConfig)`); TypeScript checks method-parameter
    // overrides bivariantly, so a required, optional, or `| undefined` override all
    // type-check against this signature, and `unknown` keeps every shape valid. When a
    // construction consumer applies several mixins that each override `initialize`, the
    // generated `interface <C>$base` re-declares this protocol signature explicitly (see
    // consumer-expand) to suppress the TS2320 "not identical" merge conflict.
    initialize(props?: unknown): void {
        Object.assign(this, props)
    }

    static new(props?: unknown): Base {
        const instance = new this()

        instance.initialize(props)

        return instance
    }

}
