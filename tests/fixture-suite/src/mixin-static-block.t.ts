import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §2 boundary: `static {}` initialization blocks.
//
// On a CONSUMER the transform rewrites the heritage; the consumer's own static block must
// survive and run exactly once on the final constructor.
//
// On a `@mixin` the class body becomes a class expression inside the runtime factory, so the
// block runs once per DISTINCT BASE the mixin is applied over (memoized per base): once for the
// canonical standalone class at `defineMixinClass` time, once more per new base in consumer
// chains — exactly the semantics static field initializers already have. NOTE: inside a mixin's
// static block refer to the class as `this`, never by name — the canonical invocation happens
// inside `defineMixinClass(...)`, before the class constant is initialized (TDZ).
let trackedBlockRuns: number = 0

@mixin()
class Tracked {
    static blockRan: boolean = false

    static {
        trackedBlockRuns++
        this.blockRan = true
    }

    describe(): string {
        return "described"
    }
}

class SomeBase {
    baseValue: number = 42
}

class WithBase extends SomeBase implements Tracked {
}

class AlsoWithBase extends SomeBase implements Tracked {
}

class NoBase implements Tracked {
}

class Consumer implements Tracked {
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

it("a static initialization block on a mixin runs once per distinct base", async (t: Test) => {
    // Canonical standalone class (1), the application over SomeBase (2), and one per base-less
    // consumer (3, 4) — each gets its OWN synthetic `__X$empty` base, so each is a distinct
    // application. AlsoWithBase applies over the SAME SomeBase as WithBase, and the per-base
    // memoization reuses that application — it does NOT add a run (4, not 5).
    t.is(trackedBlockRuns, 4, "canonical + SomeBase + one per base-less consumer's own empty base")

    t.is(Tracked.blockRan, true, "the block ran on the canonical class with `this` = the class")
    t.is(WithBase.blockRan, true, "a based consumer inherits the static set by the block")
    t.is(AlsoWithBase.blockRan, true, "a second consumer over the same base shares the application")
    t.is(NoBase.blockRan, true, "a base-less consumer inherits from the canonical class")

    t.equal(new WithBase().describe(), "described", "the mixin members are intact alongside the block")
})
