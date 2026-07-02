import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1 boundary: `this` in a PARAMETER position (`same(other: this)`) — the contravariant twin
// of the §1.14 polymorphic RETURN type — and a member type that references the mixin's own
// name (`clone(): Tagged`). Both must survive into the generated interface and resolve at the
// consumer.
@mixin()
class Tagged {
    tag: string = "t"

    same(other: this): boolean {
        return other.tag === this.tag
    }

    clone(): Tagged {
        return new Tagged()
    }
}

class Consumer implements Tagged {
    extra(): string {
        return "extra"
    }
}

const consumer = new Consumer()
const other    = new Consumer()

// Compile-time half: `this` narrows to Consumer at the call site — a plain Tagged (without
// Consumer's members) is not accepted.
const matched: boolean = consumer.same(other)

// @ts-expect-error a bare Tagged is not assignable to `this` of Consumer
consumer.same(new Tagged())

// The self-named return type stays the MIXIN type (not the consumer).
const cloned: Tagged = consumer.clone()

void [ matched, cloned ]

it("this-typed parameters and self-referencing member types", async (t: Test) => {
    t.true(consumer.same(other), "a this-typed parameter accepts another consumer instance")

    other.tag = "different"
    t.false(consumer.same(other), "the comparison actually runs")

    const clone = consumer.clone()

    t.true(clone instanceof Tagged, "the self-typed clone() constructs the standalone mixin class")
    t.equal(clone.tag, "t", "the clone carries the mixin state")
})
