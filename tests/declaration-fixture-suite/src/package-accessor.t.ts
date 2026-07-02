import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Scaled } from "ts-mixin-class-fixture-suite/mixins"

// §13 × §1.27: the generated mixin interface's REAL get/set signatures — including a SPLIT
// pair's distinct read/write types — survive the package's declaration (`.d.ts`) round trip.
// The consumer below types entirely against the emitted declarations.
class Poster implements Scaled {
}

const poster = new Poster()

const read: number = poster.scale

void read

// Type-only negative check (never executed): the split setter's type comes from the
// declarations, not from a collapsed property signature.
function typeOnlyChecks(): void {
    // @ts-expect-error the setter accepts number | string, not boolean
    poster.scale = true
}
void typeOnlyChecks

it("a split accessor pair through package declarations", async (t: Test) => {
    const p = new Poster()

    p.scale = "2.5"
    t.equal(p.height, 25, "the string branch of the split setter fires through the declaration package")

    p.scale = 4
    t.equal(p.height, 40, "…and the number branch")
    t.equal(p.scale, 4, "the getter reads back as a number")
})
