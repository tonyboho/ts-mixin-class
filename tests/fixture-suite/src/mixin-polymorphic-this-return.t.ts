import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.1 boundary: a mixin method with a polymorphic `this` return type (`self(): this`).
// When copied into the consumer's structural interface, `this` must resolve to the
// CONSUMER type at the consumer call site — so a consumer-specific member is reachable
// on the result of the inherited method, not just the mixin's own surface. (A fluent /
// builder mixin is the motivating shape.)
@mixin()
class Fluent {
    log: string[] = []

    a : string

    record(tag: string): this {
        this.log.push(tag)

        return this
    }
}

class Builder implements Fluent {
    built = false

    finish(): boolean {
        this.built = true

        return this.built
    }
}

const b = new Builder()

// `record` returns `this` === Builder, so a Builder-specific member chains off it.
const chained: boolean = b.record("a").record("b").finish()

it("mixin polymorphic this return", async (t: Test) => {
    t.equal(b.log.length, 2, "the mixin method mutated state through the polymorphic-this chain")
    t.isDeeply(b.log, [ "a", "b" ], "both chained calls ran in order")
    t.equal(chained, true, "`this` narrowed to the consumer, so a consumer member chains off the inherited method")
})

void chained
