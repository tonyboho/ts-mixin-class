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
