import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

it("bans `new` on a construction consumer with its own constructor in emit, keeping `super()`/`.new()` valid in both planes", async (t: Test) => {
    // A construction consumer that declares its OWN constructor: the emit path bans a direct `new`
    // (the brand rides on the constructor's parameter, leaving its `super()` and `.new()` intact),
    // while source view leaves it un-banned — poisoning the constructor there would inject a
    // parameter that shifts the position-preserved body and breaks navigation, so the build is what
    // catches a stray `new`. A consumer with NO own constructor is banned in both planes (covered by
    // the deep-subclass / fill-missed fixtures), through the `$base` brand instead.
    const program = (tail: string): string => `
        import { mixin, Base } from "ts-mixin-class"

        @mixin()
        class Feature {
            tag: string = "f"
        }

        class Widget extends Base implements Feature {
            id: string = ""

            constructor () {
                super()
                this.id = "w"
            }
        }
        ${tail}
    `

    for (const sourceView of [ false, true ]) {
        const plane = sourceView ? "source view" : "emit"
        const clean = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program("void Widget.new()")), { sourceView })))

        t.is(clean.length, 0, `${plane}: the consumer's own super() and .new() type-check cleanly\n${clean.join("\n")}`)
    }

    const emitBanned = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program("void new Widget()")))))
    t.ne(emitBanned.length, 0, "emit: a direct `new Widget()` is a type error for a with-constructor construction consumer")
})

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

it("fills missing initializers by default", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class ShapeBase extends Base {
            public baseValue!: number
        }

        @mixin()
        class ShapeMixin {
            public mixinValue!: string
        }

        class ShapeConsumer extends ShapeBase implements ShapeMixin {
            public ownValue!: boolean
        }

        void ShapeConsumer
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("does not fill an explicit `= undefined` — it stays a type error even in the default mode", async (t: Test) => {
    // Fill only supplies a value where NONE was written. An explicit `= undefined` on a
    // non-nullable field is the user writing a bug, so it must remain a TS2322 type error — it
    // is never silently rewritten to `undefined!`, not even under the default "undefined" mode.
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
    `), {
        // The default mode; the point is that fill does NOT rescue an explicit `= undefined`.
        fillMissedInitializersWith : "undefined"
    })

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages    = diagnostics.join("\n")

    t.match(messages, "TS2322", "An explicit `= undefined` is a type error, not silently filled")
    t.match(messages, "Type 'undefined' is not assignable to type 'number'",
        "Base field's explicit `= undefined` is rejected")
    t.match(messages, "Type 'undefined' is not assignable to type 'string'",
        "Mixin field's explicit `= undefined` is rejected")
    t.match(messages, "Type 'undefined' is not assignable to type 'boolean'",
        "Consumer field's explicit `= undefined` is rejected")
})

it("fills undefined initializers for all construction fields regardless of visibility", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class ShapeBase extends Base {
            public baseValue!: number
            public optionalBaseValue?: number
            protected protectedValue: number
            baseSkippedValue: number
        }

        @mixin()
        class ShapeMixin {
            public mixinValue!: string
        }

        class ShapeConsumer extends ShapeBase implements ShapeMixin {
            public ownValue!: boolean
            private hiddenValue: string

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

        // @ts-expect-error fill does not widen the property type; it stays number.
        const stillStrict: undefined = constructed.baseValue

        void [ baseValue, mixinValue, ownValue, stillStrict ]
    `), {
        fillMissedInitializersWith : "undefined"
    })

    const printed     = printSourceFile(ts, transformedFile)
    const diagnostics = typecheckText(printed)

    t.expect(diagnostics).toEqual([])
    // Fill is a runtime shape concern, so it is visibility-independent: public, protected,
    // private, and unmarked fields are all filled (none keeps a bare strict `= undefined`).
    t.match(printed, "protectedValue: number = undefined!", "A protected field is filled")
    t.match(printed, "baseSkippedValue: number = undefined!", "An unmarked (non-public) field is filled")
    t.match(printed, "hiddenValue: string = undefined!", "A private field is filled")
})

it("fills missing initializers for plain Base descendants", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class PlainShape extends Base {
            public value!: number
        }

        const constructed = PlainShape.new({ value : 1 })
        const value: number = constructed.value

        // @ts-expect-error fillMissedInitializersWith does not widen the property type.
        const stillStrict: undefined = constructed.value

        void [ value, stillStrict ]
    `), {
        fillMissedInitializersWith : "undefined"
    })

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})

it("requires public-only config fields for plain Base descendants", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id!: string = ""
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
