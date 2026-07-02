import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §6 boundary: one generic mixin INSTANTIATED DIFFERENTLY by two consumers in the same file;
// a consumer forwarding its OWN parameter into TWO generic mixins at once; and a subclass
// FIXING a generic consumer's parameter.
@mixin()
class Box<T> {
    content!: T

    put(value: T): this {
        this.content = value
        return this
    }
}

@mixin()
class Pair<T> {
    first!: T

    second!: T

    both(): T[] {
        return [ this.first, this.second ]
    }
}

// The same mixin, fixed to DIFFERENT types by two consumers.
class StringBox implements Box<string> {
}

class NumberBox implements Box<number> {
}

// One consumer parameter forwarded into TWO generic mixins.
class Doubled<U> implements Box<U>, Pair<U> {
}

// A subclass fixing the generic consumer's parameter.
class DoubledDates extends Doubled<Date> {
}

const stringBox = new StringBox().put("text")
const numberBox = new NumberBox().put(42)

// Compile-time half: each instantiation enforces ITS OWN type argument.
const text: string   = stringBox.content
const answer: number = numberBox.content

const doubled = new Doubled<boolean>()
doubled.put(true)
doubled.first  = false
doubled.second = true

const dates = new DoubledDates()
const day   = new Date(0)
dates.put(day)

// Type-only negative checks: the violating calls must never actually execute (the type
// errors are erased at runtime).
function instantiationsAreEnforced(): void {
    // @ts-expect-error a string box does not take a number
    stringBox.put(1)

    // @ts-expect-error a number box does not take a string
    numberBox.put("no")

    // @ts-expect-error the forwarded parameter binds BOTH mixins
    doubled.first = "not boolean"

    // @ts-expect-error the subclass fixed U to Date
    dates.put("not a date")
}

void [ text, answer, instantiationsAreEnforced ]

it("generic instantiations stay independent and forward through consumers", async (t: Test) => {
    t.equal(stringBox.content, "text", "the string instantiation holds its value")
    t.is(numberBox.content, 42, "the number instantiation holds its value")

    t.equal(doubled.both(), [ false, true ], "the second mixin sees the same forwarded parameter")
    t.is(doubled.content, true, "the first mixin works alongside on one instance")

    t.is(dates.content, day, "the subclass-fixed parameter flows into the mixin member")
    t.true(dates instanceof Doubled, "the subclass is an instanceof the generic consumer")
    t.true(dates instanceof Box, "instanceof matches the mixin regardless of instantiation")
})
