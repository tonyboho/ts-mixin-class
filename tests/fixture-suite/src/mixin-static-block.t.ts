import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §2 boundary: a `static {}` initialization block on a CONSUMER. The transform rewrites the
// consumer's heritage; the consumer's own static block must survive and run exactly once on the
// final constructor. (A static block on a `@mixin` itself is REJECTED with a diagnostic — its
// side effects would re-run for every chain application of the mixin factory; that rejection is
// pinned in `source-transform-diagnostics.t.ts`.)
@mixin()
class Describable {
    describe(): string {
        return "described"
    }
}

class Consumer implements Describable {
    static instances: number = 0

    static ready: boolean = false

    static {
        Consumer.ready = true
    }

    constructor() {
        Consumer.instances++
    }
}

it("a static initialization block on a mixin consumer", async (t: Test) => {
    t.is(Consumer.ready, true, "the consumer's static block ran on the final constructor")
    t.is(Consumer.instances, 0, "the static block did not construct anything")

    const consumer = new Consumer()

    t.equal(consumer.describe(), "described", "the consumer still carries the mixin member")
    t.is(Consumer.instances, 1, "the consumer's own constructor still runs")
})
