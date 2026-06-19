import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Measured } from "./accessor-mixin.js"

// §10 × §1.8: a consumer in a different file from the accessor-carrying mixin. Exercises
// the cross-file member-resolution path for accessors (get-only -> readonly property,
// get/set pair -> writable) — the same plane where the manual-mix dependency gap surfaced.
class Box implements Measured {
    label: string = "box"
}

const box = new Box()
box.width  = 4
box.height = 2

const t1: number = box.area
const t2: number = box.ratio
const t3: string = box.label

// Type-only negative checks (never executed).
function typeOnlyChecks(): void {
    // @ts-expect-error area is a get-only accessor on the imported mixin → readonly.
    box.area = 100
}
void typeOnlyChecks

it("resolves an imported mixin's accessors on a cross-file consumer", async (t: Test) => {
    t.equal(box.area, 8, "imported get-only accessor computes on the cross-file consumer")
    t.equal(box.ratio, 2, "imported get/set accessor reads through")

    box.ratio = 3
    t.equal(box.width, 6, "imported setter mutates state (width = height * ratio)")
    t.equal(box.area, 12, "imported get-only accessor reflects the setter mutation")

    t.isInstanceOf(box, Measured, "cross-file consumer matches the imported accessor mixin")
})

void [ t1, t2, t3 ]
