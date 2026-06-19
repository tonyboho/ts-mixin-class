export type AnyConstructor<T extends object = object> = new (...args: any[]) => T

export type ClassStatics<C> = Omit<C, "prototype">

export type MixinFactory = (base: AnyConstructor<any>) => AnyConstructor<any>

export type MixinApplication<
    Base extends AnyConstructor<any>,
    MixinInstance extends object,
    MixinStatics
> =
    (new (...args: ConstructorParameters<Base>) => InstanceType<Base> & MixinInstance) &
    ClassStatics<Base> &
    ClassStatics<MixinStatics>

export const factory: unique symbol = Symbol.for("ts-mixin-class.factory")
export const requirements: unique symbol = Symbol.for("ts-mixin-class.requirements")
export const base: unique symbol = Symbol.for("ts-mixin-class.base")

export class Base {
    // `props` is `unknown` so a subclass can override `initialize` with a STRICTER,
    // required-field config - its generated `<ClassName>Config` alias
    // (`override initialize(config: ModelConfig)`). A narrower parameter than the base
    // would be an unsound narrowing TypeScript rejects (TS2416), so the base parameter
    // must be the top type. `unknown` keeps every override shape valid and lets the
    // generated, strict `static new(props: <ClassName>Config)` override this signature.
    // (A `@mixin` that overrides `initialize` is structurally merged into its consumers'
    // generated base interface alongside `Base`, which requires the two `initialize`
    // signatures to be IDENTICAL - so a mixin's `initialize` override must also use
    // `unknown`, not its own alias.)
    initialize(props?: unknown): void {
        Object.assign(this, props)
    }

    static new(props?: unknown): Base {
        const instance = new this()

        instance.initialize(props)

        return instance
    }

}
