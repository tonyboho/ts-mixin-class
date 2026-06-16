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
