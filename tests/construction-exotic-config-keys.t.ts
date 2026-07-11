import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

async function assertBothPlanesCompile(t: Test, source: string, description: string): Promise<void> {
    const emit       = await buildConstructionSource(source)
    const sourceView = await buildConstructionSource(source, { noEmit: true })

    t.equal(emit.exitCode, 0, `${description} (emit).\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `${description} (source view).\n${commandOutput(sourceView)}`)
}

it("numeric, string-literal and computed-string fields are construction config keys", async (t: Test) => {
    await assertBothPlanesCompile(
        t,
        trimIndent(`
        import { Base } from "ts-mixin-class"

        const computed = "computed" as const

        class Exotic extends Base {
            public 0!: string
            public "dash-name"!: number
            public [computed]!: boolean
        }

        const value = Exotic.new({ 0: "zero", "dash-name": 1, computed: true })

        const zero: string = value[0]
        const dashed: number = value["dash-name"]
        const calculated: boolean = value[computed]

        function typeOnlyChecks(): void {
            // @ts-expect-error every non-optional exotic field remains required
            Exotic.new({ 0: "zero", "dash-name": 1 })

            // @ts-expect-error the numeric field keeps its string value type
            Exotic.new({ 0: 0, "dash-name": 1, computed: true })

            // @ts-expect-error the computed-string field keeps its boolean value type
            Exotic.new({ 0: "zero", "dash-name": 1, computed: "yes" })
        }

        void [ zero, dashed, calculated, typeOnlyChecks ]
    `),
        "literal and computed string keys retain requiredness and value types"
    )
})

it("unique-symbol fields and setters are construction config keys", async (t: Test) => {
    await assertBothPlanesCompile(
        t,
        trimIndent(`
        import { Base } from "ts-mixin-class"

        const field: unique symbol = Symbol("field")
        const writable: unique symbol = Symbol("writable")

        class Symbolic extends Base {
            public [field]!: string

            private stored: number = 0

            public get [writable](): number {
                return this.stored
            }

            public set [writable](value: number | string) {
                this.stored = Number(value)
            }
        }

        const value = Symbolic.new({ [field]: "ok", [writable]: "2" })

        const readField: string = value[field]
        const readAccessor: number = value[writable]

        function typeOnlyChecks(): void {
            // @ts-expect-error the unique-symbol data field is required
            Symbolic.new({ [writable]: 1 })

            // @ts-expect-error the symbol field is string-valued
            Symbolic.new({ [field]: 1 })

            // @ts-expect-error the symbol setter accepts number | string, not boolean
            Symbolic.new({ [field]: "ok", [writable]: true })
        }

        void [ readField, readAccessor, typeOnlyChecks ]
    `),
        "symbol keys retain identity, requiredness and setter write types"
    )
})

it("numeric, string and symbol index signatures constrain construction config values", async (t: Test) => {
    await assertBothPlanesCompile(
        t,
        trimIndent(`
        import { Base } from "ts-mixin-class"

        class NumberBag extends Base {
            [index: number]: string
        }

        class StringBag extends Base {
            // Base.initialize is itself a string-named member, so the ordinary TS index
            // contract must admit that one inherited function alongside numeric bag values.
            [key: string]: number | Base["initialize"]
        }

        class SymbolBag extends Base {
            [key: symbol]: boolean
        }

        NumberBag.new({ 0: "zero", 1: "one" })
        StringBag.new({ first: 1, second: 2 })
        SymbolBag.new({ [Symbol("one")]: true })

        function typeOnlyChecks(): void {
            // @ts-expect-error numeric index values are strings
            NumberBag.new({ 0: 123 })

            // @ts-expect-error string index values are numbers
            StringBag.new({ first: "wrong" })

            // @ts-expect-error symbol index values are boolean
            SymbolBag.new({ [Symbol("bad")]: "wrong" })
        }

        void typeOnlyChecks
    `),
        "index-signature and symbol-key value types constrain .new configs"
    )
})

it("exotic construction keys have class/mixin/consumer parity", async (t: Test) => {
    await assertBothPlanesCompile(
        t,
        trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        const symbolKey: unique symbol = Symbol("mixin-key")
        const computed = "computed" as const

        @mixin()
        class ExoticMixin extends Base {
            public 0!: string
            public [computed]!: number
            public [symbolKey]!: boolean
        }

        class Consumer extends Base implements ExoticMixin {
            public own!: Date
        }

        const standalone = ExoticMixin.new({ 0: "zero", computed: 1, [symbolKey]: true })
        const consumed = Consumer.new({
            0: "zero",
            computed: 1,
            [symbolKey]: true,
            own: new Date()
        })

        function typeOnlyChecks(): void {
            // @ts-expect-error the mixin's symbol field remains required on standalone .new
            ExoticMixin.new({ 0: "zero", computed: 1 })

            // @ts-expect-error the same symbol field remains required after consumer aggregation
            Consumer.new({ 0: "zero", computed: 1, own: new Date() })
        }

        void [ standalone, consumed, typeOnlyChecks ]
    `),
        "exotic keys are aggregated identically for a construction mixin and its consumer"
    )
})
