import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource, readConstructionConfigDts } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

// §7 × §1.20: a PUBLIC PARAMETER PROPERTY on a construction class's own constructor
// (`constructor(public tag: string = …)`) declares a real public assignable instance member —
// so it must be a `.new` config key, exactly like a declared public field. It is always
// OPTIONAL in the config: the constructor runs first (the native-construct step of `.new`,
// §9.1) and supplies the default; `Object.assign` then overrides it with the config value.

const parameterPropertySource = trimIndent(`
    import { Base } from "ts-mixin-class"

    export class Ticket extends Base {
        constructor(public tag: string = "untagged") {
            super()
        }
    }

    const explicit = Ticket.new({ tag: "spec" })
    const defaulted = Ticket.new({})

    const read: string = explicit.tag

    void [ read, defaulted ]
`)

it("a public parameter property on a construction class is a .new config key", async (t: Test) => {
    const result = await buildConstructionSource(parameterPropertySource)

    t.equal(result.exitCode, 0,
        `the parameter property is accepted (optionally) by .new.\n${commandOutput(result)}`)
})

it("the parameter property appears in the generated <Class>Config", async (t: Test) => {
    const dts = await readConstructionConfigDts(parameterPropertySource)

    t.match(dts, "tag?: string", `TicketConfig carries the parameter property as an optional key.\n${dts}`)
})
