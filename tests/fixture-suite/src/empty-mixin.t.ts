import { mixin } from "ts-mixin-class"
import { factory, requirements } from "ts-mixin-class/base"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1 boundary: an **empty** mixin (no members) — a valid marker mixin that contributes
// only `instanceof` branding. Exercises the zero-member interface path
// (`interfaceMembers` -> `zeroWidthRange` when `members.length === 0`), which has no other
// coverage. Must not crash the transformer and must still brand consumers and standalones.
@mixin()
class Marker {
}

// A second empty mixin that depends on the first — empty body + a dependency.
@mixin()
class TaggedMarker implements Marker {
}

class Base {
    value: number = 1
}

class Consumer extends Base implements TaggedMarker {
    own(): string {
        return "consumer"
    }
}

const consumer = new Consumer()
const standalone = new Marker()

const t1: string = consumer.own()
const t2: number = consumer.value

const asMarker: Marker = consumer

it("supports empty marker mixins", async (t: Test) => {
    t.equal(consumer.own(), "consumer", "consumer of an empty mixin keeps its own members")
    t.equal(consumer.value, 1, "consumer of an empty mixin keeps base members")

    t.isInstanceOf(consumer, Marker, "empty mixin still brands the consumer (transitively)")
    t.isInstanceOf(consumer, TaggedMarker, "empty dependent mixin brands the consumer")
    t.isInstanceOf(standalone, Marker, "empty mixin can be instantiated standalone")

    t.equal(typeof Marker[factory], "function", "empty mixin still exposes its factory metadata")
    t.expect(Marker[requirements]).toEqual([])
    t.expect(TaggedMarker[requirements]).toEqual([ Marker ])
})

void [ t1, t2, asMarker ]
