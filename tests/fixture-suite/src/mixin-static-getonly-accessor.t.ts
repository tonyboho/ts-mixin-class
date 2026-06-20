import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.11 boundary: a mixin's STATIC GET-ONLY accessor (no setter), not the static get/set
// pair already covered. The getter must surface as a real (read-only) static accessor on
// the consumer's constructor: it computes from static state, and — being get-only — it is
// not assignable through the consumer's static type.
@mixin()
class Versioned {
    static _major: number = 3
    static _minor: number = 1

    static get version(): string {
        return `${Versioned._major}.${Versioned._minor}`
    }
}

class Plugin implements Versioned {
}

// Type-only negative check (never executed): get-only ⇒ not assignable through the
// consumer's static type.
function typeOnlyChecks(): void {
    // @ts-expect-error a get-only static accessor is not assignable
    Versioned.version = "9.9"

    // @ts-expect-error a get-only static accessor is not assignable
    Plugin.version = "9.9"
}
void typeOnlyChecks

it("mixin static get-only accessor", async (t: Test) => {
    // Reachable as a static accessor on the consumer's constructor; the getter computes.
    t.equal(Plugin.version, "3.1",
        "static getter on the consumer computes from the shared static state")

    // And on the mixin itself.
    t.equal(Versioned.version, "3.1", "the get-only static accessor is reachable on the mixin too")
})
