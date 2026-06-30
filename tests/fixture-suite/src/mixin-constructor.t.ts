import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// A base-less `@mixin` may declare its OWN constructor. It is preserved in the runtime factory
// (with a synthetic no-arg `super()` so the wrapping `class extends base` stays a valid derived
// class), so a direct `new` runs the constructor body. The mixin still type-checks and brands.
@mixin()
class Counter {
    count: number
    log: string[]

    constructor() {
        this.count = 1
        this.log = [ "constructed" ]
    }

    tick(): number {
        this.count += 1

        return this.count
    }
}

// A dependent base-less mixin with its own constructor: the dependency's constructor has already
// run through the synthetic `super()` chain by the time this body executes, so it observes the
// dependency's constructor-assigned state.
@mixin()
class LabeledCounter implements Counter {
    label: string

    constructor() {
        this.label = `count=${this.count}`
    }

    describe(): string {
        return `${this.label}/${this.log.join(",")}`
    }
}

const counter = new Counter()
const labeled = new LabeledCounter()

// Type checks (verified at build time): the mixin value is `new`-able and its instance carries
// the declared members.
const count: number       = counter.count
const ticked: number      = counter.tick()
const description: string = labeled.describe()

it("preserves and runs a base-less mixin constructor on direct new", async (t: Test) => {
    t.equal(count, 1, "Standalone mixin constructor body runs on direct new")
    t.equal(ticked, 2, "Mixin methods see constructor-assigned state")
    t.equal(counter.log.join(","), "constructed", "Constructor side effects are observable")
    t.isInstanceOf(counter, Counter, "Constructed standalone mixin is branded")

    t.equal(labeled.count, 1, "Dependency constructor runs before the dependent's via super()")
    t.equal(labeled.describe(), "count=1/constructed", "Dependent mixin constructor sees dependency state")
    t.isInstanceOf(labeled, Counter, "Dependent mixin instance matches its dependency")
    t.isInstanceOf(labeled, LabeledCounter, "Dependent mixin instance matches itself")
})

void [ count, ticked, description ]
