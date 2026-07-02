import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §3 boundary: the ORDER field initializers run across the linearized chain. Fields initialize
// per constructor layer, base-most first; §2.6 pins that the FIRST-listed mixin in `implements`
// is the NEAREST chain layer (its members win), so its fields must initialize LAST among the
// mixins, and the consumer's own fields after all of them.
const order: string[] = []

function record(label: string): string {
    order.push(label)
    return label
}

@mixin()
class TrackFirst {
    first: string = record("first-listed")
}

@mixin()
class TrackSecond {
    second: string = record("second-listed")
}

class Tracker implements TrackFirst, TrackSecond {
    own: string = record("consumer-own")
}

const tracker = new Tracker()

it("field initializers run base-most first across the linearized chain", async (t: Test) => {
    t.equal(order, [ "second-listed", "first-listed", "consumer-own" ],
        "the first-listed mixin is the nearest layer, so it initializes after the second-listed; the consumer's own fields run last")

    t.equal(tracker.first, "first-listed", "all fields are present on the one instance")
    t.equal(tracker.second, "second-listed", "…from every layer")
    t.equal(tracker.own, "consumer-own", "…including the consumer's own")
})
