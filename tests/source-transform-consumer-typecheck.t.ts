import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

it("transformed mixin output typechecks, including generics, statics and super calls", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { base, factory, mixin, requirements } from "ts-mixin-class"

        @mixin()
        export class SourceClass1<T> {
            static staticHelper (x: number): number { return x * 2 }

            value1: string = "value1"

            passThrough1 (a: T): T { return a }

            method1 (): string { return this.value1 }

            makeAnother (): SourceClass1<number> {
                return new SourceClass1<number>()
            }
        }

        @mixin()
        export class ChildMixin<T> implements SourceClass1<T> {
            childMethod (a: T): string {
                return "child/" + String(super.passThrough1(a)) + "/" + super.method1()
            }
        }

        const direct = new SourceClass1<number>()

        const v1: number = direct.passThrough1(3)
        const v2: number = SourceClass1.staticHelper(2)
        const v3: SourceClass1<number> = direct.makeAnother()
        const v4 = SourceClass1[factory]
        const v5 = SourceClass1[requirements]
        const v6 = SourceClass1[base]

        // @ts-expect-error дженерик T = number, строка не подходит
        const e1: number = direct.passThrough1("x")

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e2 = SourceClass1.$mixin

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e3 = SourceClass1.$requirements

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e4 = SourceClass1.$requiredBase

        const child = new ChildMixin<boolean>()

        const v7: string = child.childMethod(true)
        const v8: boolean = child.passThrough1(false)

        // @ts-expect-error childMethod принимает T = boolean
        const e5: string = child.childMethod("x")

        void [v1, v2, v3, v4, v5, v6, v7, v8, e1, e2, e3, e4, e5]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("transformed required-base mixin output typechecks end to end", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class RequiredBase<T> {
            requiredValue: T

            constructor (requiredValue: T) {
                this.requiredValue = requiredValue
            }

            requiredMethod (): T {
                return this.requiredValue
            }

            static staticRequired (): string {
                return "staticRequired"
            }
        }

        class RealBase extends RequiredBase<string> {
            override requiredMethod (): string {
                return "real/" + super.requiredMethod()
            }
        }

        @mixin()
        class RequiredMixin extends RequiredBase<string> {
            mixinValue: string = "mixin"

            mixinMethod (): string {
                return super.requiredMethod() + "/" + this.mixinValue
            }

            static staticMixin (): string {
                return "staticMixin"
            }
        }

        class Consumer extends RealBase implements RequiredMixin {
            own (): string {
                return super.mixinMethod()
            }
        }

        class DefaultConsumer implements RequiredMixin {
        }

        const consumer = new Consumer("base")

        const v1: string = consumer.requiredMethod()
        const v2: string = consumer.mixinMethod()
        const v3: string = consumer.own()
        const v4: string = Consumer.staticRequired()
        const v5: string = Consumer.staticMixin()

        const defaultConsumer = new DefaultConsumer("default")
        const v6: string = defaultConsumer.requiredMethod()
        const v7: string = defaultConsumer.mixinMethod()

        // @ts-expect-error required base generic is fixed as string.
        const e1: number = consumer.requiredValue

        void [ v1, v2, v3, v4, v5, v6, v7, e1 ]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("transformed generic consumer base output typechecks", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        class Base<T> {
            baseValue: T

            constructor (baseValue: T) {
                this.baseValue = baseValue
            }

            baseMethod (): T {
                return this.baseValue
            }
        }

        class Consumer<A> extends Base<A> implements SourceClass1<string> {
            method (): A {
                return super.baseMethod()
            }
        }

        const consumer = new Consumer<number>(42)

        const v1: number = consumer.baseValue
        const v2: number = consumer.method()
        const v3: string = consumer.passThrough1("x")

        // @ts-expect-error Base<T> is instantiated as Base<number>.
        const e1: string = consumer.baseValue

        // @ts-expect-error SourceClass1 is instantiated as SourceClass1<string>.
        const e2: number = consumer.passThrough1(1)

        void [v1, v2, v3, e1, e2]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("consumer constructor without explicit base typechecks after synthetic super injection", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class StoredValue<T> {
            value: T | undefined

            getValue (): T | undefined {
                return this.value
            }
        }

        @mixin()
        class ValueLabel<T> implements StoredValue<T> {
            label (): string {
                return String(super.getValue())
            }
        }

        class Box<T> implements ValueLabel<T>, StoredValue<T> {
            ownValue: T

            constructor (value: T) {
                this.ownValue = value
            }
        }

        const box = new Box<number>(42)

        box.value = 42

        const value: number | undefined = box.getValue()
        const label: string = box.label()
        const ownValue: number = box.ownValue

        void [ value, label, ownValue ]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("manual mix property application typechecks", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class ManualBase {
            baseValue: number

            constructor (baseValue: number) {
                this.baseValue = baseValue
            }

            static baseStatic (): string {
                return "base"
            }
        }

        @mixin()
        class TaggedValue {
            static mixinStatic (): string {
                return "mixin"
            }

            value: string | undefined

            getValue (): string | undefined {
                return this.value
            }
        }

        @mixin()
        class StoredValue<T> {
            value: T | undefined

            getValue (): T | undefined {
                return this.value
            }
        }

        class ManualBox extends TaggedValue.mix(ManualBase) {
        }

        class GenericManualBox extends StoredValue.mix<string, typeof ManualBase>(ManualBase) {
        }

        const box = new ManualBox(10)
        const genericBox = new GenericManualBox(10)

        box.value = "value"
        genericBox.value = "generic"

        const value: string | undefined = box.getValue()
        const baseValue: number = box.baseValue
        const baseStatic: string = ManualBox.baseStatic()
        const mixinStatic: string = ManualBox.mixinStatic()
        const genericValue: string | undefined = genericBox.getValue()

        // @ts-expect-error Generic mix parameters must include the base type when mixin type arguments are explicit.
        StoredValue.mix<string>(ManualBase)

        // @ts-expect-error StoredValue is applied as StoredValue<string>.
        genericBox.value = 10

        // @ts-expect-error TaggedValue.value is string.
        box.value = 10

        // @ts-expect-error ManualBase constructor still requires a number.
        new ManualBox("bad")

        // @ts-expect-error ManualBase constructor still requires a number.
        new GenericManualBox("bad")

        void [ value, baseValue, baseStatic, mixinStatic, genericValue ]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("public-only construction config rejects undefined initializers by default", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class ShapeBase extends Base {
            public baseValue: number = undefined
        }

        @mixin()
        class ShapeMixin {
            public mixinValue: string = undefined
        }

        class ShapeConsumer extends ShapeBase implements ShapeMixin {
            public ownValue: boolean = undefined
        }

        void ShapeConsumer
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages = diagnostics.join("\n")

    t.match(messages, "TS2322", "Plain undefined initializer is still rejected without opt-in")
    t.match(messages, "Type 'undefined' is not assignable to type 'number'",
        "Base public-only config field keeps the original strict initializer diagnostic")
    t.match(messages, "Type 'undefined' is not assignable to type 'string'",
        "Mixin public-only config field keeps the original strict initializer diagnostic")
    t.match(messages, "Type 'undefined' is not assignable to type 'boolean'",
        "Consumer public-only config field keeps the original strict initializer diagnostic")
})

it("can allow undefined initializers for public-only construction config fields", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class ShapeBase extends Base {
            public baseValue: number = undefined
            public optionalBaseValue?: number = undefined
            baseSkippedValue: number = undefined
        }

        @mixin()
        class ShapeMixin {
            public mixinValue: string = undefined
        }

        class ShapeConsumer extends ShapeBase implements ShapeMixin {
            public ownValue: boolean = undefined

            constructor () {
                super()
            }
        }

        const constructed = ShapeConsumer.new({
            baseValue  : 1,
            mixinValue : "value",
            ownValue   : true
        })

        const baseValue: number = constructed.baseValue
        const mixinValue: string = constructed.mixinValue
        const ownValue: boolean = constructed.ownValue

        // @ts-expect-error public-only config field type stays number, not number | undefined.
        const stillStrict: undefined = constructed.baseValue

        void [ baseValue, mixinValue, ownValue, stillStrict ]
    `), {
        allowUndefinedForRequiredProperties : true
    })

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.equal(diagnostics.length, 1, "Only the non-public field keeps the strict undefined initializer diagnostic")
    t.match(diagnostics[0], "TS2322", "The remaining diagnostic is the assignability error")
    t.match(diagnostics[0], "Type 'undefined' is not assignable to type 'number'",
        "The remaining diagnostic comes from the intentionally skipped field")
})

it("can allow undefined initializers for plain Base descendants", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class PlainShape extends Base {
            public value: number = undefined
        }

        const constructed = PlainShape.new({ value : 1 })
        const value: number = constructed.value

        // @ts-expect-error allowUndefinedForRequiredProperties does not widen the property type.
        const stillStrict: undefined = constructed.value

        void [ value, stillStrict ]
    `), {
        allowUndefinedForRequiredProperties : true
    })

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("requires public-only config fields for plain Base descendants", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id: string = ""
            public name?: string = ""
            skippedValue: string = ""
        }

        Model.new({ id : "ok" })

        // @ts-expect-error public-only config requires public fields without a question mark.
        Model.new()

        // @ts-expect-error public-only config requires public fields without a question mark.
        Model.new({})

        // @ts-expect-error public-only config excludes fields without an explicit public modifier.
        Model.new({ id : "ok", skippedValue : "nope" })
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("transformed consumer output typechecks end to end", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class SourceClass1<T> {
            static staticHelper (x: number): number { return x * 2 }

            value1: string = "value1"

            passThrough1 (a: T): T { return a }

            method1 (): string { return this.value1 }
        }

        @mixin()
        export class SourceClass2<A> {
            value2: string = "value2"

            passThrough2 (a: A): A { return a }

            method2 (): string { return this.value2 }
        }

        class Base {
            baseValue: number = 42

            static staticBase (): string { return "staticBase" }
        }

        class Consumer1<T, A> implements SourceClass1<T>, SourceClass2<A> {
        }

        class Consumer2<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
            method1 (): string {
                return "consumer2/" + super.method1()
            }
        }

        const c1 = new Consumer1<string, number>()

        const v1: string = c1.passThrough1("x")
        const v2: number = c1.passThrough2(1)

        // @ts-expect-error дженерик T = string
        const e1: string = c1.passThrough1(1)

        const c2 = new Consumer2<boolean>()

        const v3: string  = c2.passThrough1("fixed")
        const v4: boolean = c2.passThrough2(true)
        const v5: number  = c2.baseValue
        const v6: string  = Consumer2.staticBase()
        const v7: number  = Consumer2.staticHelper(3)

        // @ts-expect-error первый миксин зафиксирован как SourceClass1<string>
        const e2: string = c2.passThrough1(1)

        const asMixin: SourceClass1<string> = c2
        const asBase: Base = c2

        class SubConsumer<A> extends Consumer2<A> {
            method2 (): string {
                return "sub/" + super.method2()
            }
        }

        const v8: number = new SubConsumer<number>().passThrough2(7)

        void [v1, v2, v3, v4, v5, v6, v7, v8, e1, e2, asMixin, asBase]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})
