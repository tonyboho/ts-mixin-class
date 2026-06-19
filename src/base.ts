export type AnyConstructor<T extends object = object> = new (...args: any[]) => T

// Type-only conformance assertion. The emit path lowers a `@mixin` class to a value
// cast `const X = defineMixinClass(...) as unknown as <type>`, whose `as unknown as`
// erases the structural check between the runtime mixin body and the contracts it
// `implements`. Referencing this alias over the runtime instance type and the contract
// re-imposes that check (the constraint `TInstance extends TContract` reports the
// missing/mismatched member) without emitting any runtime code, so `tsc` flags a mixin
// that does not satisfy its `implements` contract just like the IDE / `--noEmit` path.
export type MixinImplements<TInstance extends TContract, TContract> = TInstance

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

export type NonFunctionPropertyNames<T> = {
    [Key in keyof T]: T[Key] extends (...args: any[]) => any ? never : Key
}[keyof T]

export type Config<T> = Partial<Pick<T, NonFunctionPropertyNames<T>>>

export class Base {
    initialize(props?: Config<this>): void {
        if (props !== undefined) {
            Object.assign(this, props)
        }
    }

    static new(props?: Config<Base>): Base {
        const instance = new this()

        instance.initialize(props)

        return instance
    }

}
