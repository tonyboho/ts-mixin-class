import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1 boundary: COMPUTED, symbol-named mixin members — a well-known symbol (`Symbol.iterator`)
// and a module-level `unique symbol`. The member must survive into the consumer's generated
// interface (a computed name is only interface-legal for a unique symbol) and work at runtime:
// the consumer iterates with `for..of`, and the unique-symbol method is callable through the
// bracket access.
export const describeSymbol: unique symbol = Symbol("describe")

@mixin()
class Iterable3 {
    [Symbol.iterator](): Iterator<number> {
        return [ 1, 2, 3 ][Symbol.iterator]()
    }

    [describeSymbol](): string {
        return "described"
    }
}

class Consumer implements Iterable3 {
    collect(): number[] {
        return [ ...this ]
    }
}

it("symbol-named mixin members (well-known and unique symbol)", async (t: Test) => {
    const consumer = new Consumer()

    t.eq(consumer.collect(), [ 1, 2, 3 ], "`[Symbol.iterator]` from the mixin makes the consumer iterable inside its own method")
    t.eq([ ...consumer ], [ 1, 2, 3 ], "the consumer instance spreads at the use site too")
    t.equal(consumer[describeSymbol](), "described", "the unique-symbol method is callable on the consumer")

    const canonical = new Iterable3()

    t.eq([ ...canonical ], [ 1, 2, 3 ], "a standalone mixin instance keeps the well-known symbol member")
})
