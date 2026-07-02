import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource, readConstructionConfigDts } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

// Config SHAPES of a construction MIXIN's own standalone `.new` — the parity twin of the
// class/consumer-side pins (§7.5c/§7.5d settable + split accessors, §7.6/§7.6a `!` + readonly,
// §7.7 unknown keys, §7.17 parameter properties). The mixin's `.new` is generated on a
// DIFFERENT path (`createMixinConstructionNewType` value-cast in emit, `static new` members in
// source view), so each shape must be pinned against the mixin's own factory too.

it("a construction MIXIN's split accessor is a config key typed by the SETTER", async (t: Test) => {
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Panel extends Base {
            stored: number = 10

            public get scale(): number {
                return this.stored / 10
            }

            public set scale(value: number | string) {
                this.stored = 10 * Number(value)
            }
        }

        const panel = Panel.new({ scale: "2.5" })

        const read: number = panel.scale

        function typeOnlyChecks(): void {
            // @ts-expect-error the setter accepts number | string, not boolean
            Panel.new({ scale: true })
        }

        void typeOnlyChecks
        void read
    `)

    const result = await buildConstructionSource(source)

    t.equal(result.exitCode, 0,
        `the string branch of the split setter is accepted by the mixin's own .new.\n${commandOutput(result)}`)

    const dts = await readConstructionConfigDts(source)

    t.match(dts, "scale?: number | string", `the config key carries the setter type.\n${dts}`)
})

it("a construction MIXIN's readonly + definite-assignment fields shape its config like a class's", async (t: Test) => {
    const result = await buildConstructionSource(trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Ticket extends Base {
            public readonly id!: string

            public label: string = ""

            describe(): string {
                return this.id + "/" + this.label
            }
        }

        const ticket = Ticket.new({ id: "a", label: "x" })

        const readId: string = ticket.id

        function typeOnlyChecks(): void {
            // @ts-expect-error the definite-assignment field is a REQUIRED config key
            Ticket.new({ label: "x" })

            // @ts-expect-error unknown config keys are rejected
            Ticket.new({ id: "a", extra: 1 })

            // @ts-expect-error a method is not a config key
            Ticket.new({ id: "a", describe: () => "" })

            // @ts-expect-error the readonly field stays immutable on the constructed instance
            ticket.id = "b"
        }

        void typeOnlyChecks
        void readId
    `))

    t.equal(result.exitCode, 0,
        `required-ness, unknown-key rejection, method exclusion and readonly all hold on the mixin's .new.\n${commandOutput(result)}`)
})

it("config LAYERING through a construction mixin DEPENDENCY (parity twin of §7.16's extends chain)", async (t: Test) => {
    const result = await buildConstructionSource(trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Doc extends Base {
            public title: string = "untitled"
        }

        @mixin()
        export class Signed extends Base implements Doc {
            public title: string = "signed"

            public signer!: string
        }

        const defaulted = Signed.new({ signer: "bob" })

        const titled: string = defaulted.title

        const explicit = Signed.new({ signer: "ann", title: "contract" })

        function typeOnlyChecks(): void {
            // @ts-expect-error the mixin's OWN required key is enforced
            Signed.new({ title: "x" })
        }

        void typeOnlyChecks
        void [ titled, explicit ]
    `))

    t.equal(result.exitCode, 0,
        `a re-declared inherited key (new default) + an own required key layer through the dependency.\n${commandOutput(result)}`)
})

it("a module-LOCAL construction mixin does not leak its config alias (parity twin of §7.15)", async (t: Test) => {
    const dts = await readConstructionConfigDts(trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        class Internal extends Base {
            public label: string = ""
        }

        const made = Internal.new({ label: "x" })

        export const label: string = made.label
    `))

    t.notMatch(dts, "export type InternalConfig", `the alias export tracks the mixin's own.\n${dts}`)
})

it("a public PARAMETER PROPERTY on a construction MIXIN's constructor is a config key of its own .new", async (t: Test) => {
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Tagged extends Base {
            constructor(public tag: string = "untagged") {
                super()
            }
        }

        const tagged = Tagged.new({ tag: "spec" })

        const read: string = tagged.tag

        void read
    `)

    const result = await buildConstructionSource(source)

    t.equal(result.exitCode, 0,
        `the parameter property is accepted (optionally) by the mixin's own .new.\n${commandOutput(result)}`)

    const dts = await readConstructionConfigDts(source)

    t.match(dts, "tag?: string", `TaggedConfig carries the parameter property as an optional key.\n${dts}`)
})
