import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1 / §11.7: a mixin may declare an **index signature** (`[key: string]: T`). It is a
// type-only member — copied into the generated mixin interface (emit + source-view),
// erased at runtime — so a consumer gains the dynamic member shape. (Source-view cleanliness
// is additionally guarded by the tsserver "stay clean" sweep over every fixture.)
@mixin()
class NumberBag {
    [key: string]: number

    count: number = 0
}

class Bag implements NumberBag {
}

const bag = new Bag()
bag.alpha = 1
bag.beta  = 2

const t1: number = bag.alpha
const t2: number = bag.count
const t3: number = bag["dynamic-key"]

// @ts-expect-error the index signature constrains values to number.
bag.gamma = "not a number"

it("supports an index signature on a mixin", async (t: Test) => {
    t.equal(bag.alpha, 1, "index-signature member assigned via a static key")
    t.equal(bag.beta, 2, "second index-signature member")

    bag["computed"] = 7
    t.equal(bag["computed"], 7, "index-signature member assigned via a computed key")

    t.equal(bag.count, 0, "a concrete member coexisting with the index signature works")
    t.isInstanceOf(bag, NumberBag, "consumer of an index-signature mixin is branded")
})

void [ t1, t2, t3 ]
