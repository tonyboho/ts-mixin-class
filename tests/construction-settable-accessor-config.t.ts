import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput } from "./util.js"
import { buildConstructionSource } from "./construction-build-util.js"

// SPEC (currently UNMET — this test is expected to be RED until fixed): a construction
// class's generated `<ClassName>Config` should include a **settable** accessor (a get/set
// pair or a set-only accessor), because such an accessor is a public, assignable member —
// and `.new`'s runtime config assignment is `Object.assign(this, props)`, whose `[[Set]]`
// semantics already fire the accessor's setter. So `.new({ full: "…" })` ought to compile
// and run the setter. Today the config is built from data fields only and excludes all
// accessors, so passing a settable accessor is rejected with TS2353.
//
// A get-only accessor must stay excluded (not assignable) — that part is already correct
// and is covered green by `fixture-suite/src/construction-accessor-config.t.ts`.
const settableAccessorConfigText = `
import { Base } from "ts-mixin-class/base"

class Profile extends Base {
    // optional data fields so the config requirement under test is purely the accessor
    public first?: string
    public last?: string

    // get/set pair: settable -> should be in the construction config
    public get full(): string {
        return (this.first ?? "") + " " + (this.last ?? "")
    }

    public set full(value: string) {
        const parts = value.split(" ")
        this.first = parts[0] ?? ""
        this.last = parts[1] ?? ""
    }

    // set-only accessor: also settable -> should be in the construction config
    public set initials(value: string) {
        this.first = value[0] ?? ""
        this.last = value[1] ?? ""
    }
}

// Desired: both settable accessors are part of the construction config.
const p = Profile.new({ full: "Ada Lovelace" })
const q = Profile.new({ initials: "AL" })

void [ p.first, p.last, p.full, q.first ]
`

it("includes a settable accessor in the construction config", async (t: Test) => {
    const emitResult       = await buildConstructionSource(settableAccessorConfigText, undefined)
    const sourceViewResult = await buildConstructionSource(settableAccessorConfigText, { noEmit : true })

    t.equal(emitResult.exitCode, 0,
        `A settable accessor should be accepted by .new config (emit).\n${commandOutput(emitResult)}`)

    t.equal(sourceViewResult.exitCode, 0,
        `A settable accessor should be accepted by .new config (source-view).\n${commandOutput(sourceViewResult)}`)
})
