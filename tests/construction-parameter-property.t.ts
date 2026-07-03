import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource, readConstructionConfigDts } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

// §7.17: a PUBLIC PARAMETER PROPERTY on a construction class's own constructor
// (`constructor(public tag: string = …)`) is NOT a `.new` config key — BY DESIGN. Config
// keys come from declared class members (fields and settable accessors); a parameter
// property stays an ordinary runtime/interface member whose value comes from the
// constructor (the native-construct step of `.new`, §9.1). To make it configurable,
// declare a class field.
//
// The declared `name!` field alongside it is load-bearing: it keeps the config NON-empty,
// so the pins below actually check the key set (an all-optional EMPTY config type accepts
// any object literal without excess-key checking — the trap that hid this contract).

const parameterPropertySource = trimIndent(`
    import { Base } from "ts-mixin-class"

    export class Ticket extends Base {
        public name!: string

        constructor(public tag: string = "untagged") {
            super()
        }
    }

    const made = Ticket.new({ name: "spec" })

    const readTag: string = made.tag
    const readName: string = made.name

    // @ts-expect-error the required declared field is a config key…
    Ticket.new({})

    // @ts-expect-error …while the parameter property is NOT one (excess key).
    Ticket.new({ name: "spec", tag: "custom" })

    void [ readTag, readName ]
`)

it("a public parameter property on a construction class is NOT a .new config key", async (t: Test) => {
    const result = await buildConstructionSource(parameterPropertySource)

    t.equal(result.exitCode, 0,
        `the config accepts declared fields only; the parameter property member still exists.\n${commandOutput(result)}`)
})

it("the generated <Class>Config carries only the declared field", async (t: Test) => {
    const dts = await readConstructionConfigDts(parameterPropertySource)

    // The EXACT alias (not a substring of the whole .d.ts — the emitted
    // `constructor(tag?: string)` signature would false-match a loose pin).
    t.match(dts, 'export type TicketConfig = Pick<Ticket, "name">',
        `TicketConfig keys are exactly the declared members — no parameter property.\n${dts}`)
})
