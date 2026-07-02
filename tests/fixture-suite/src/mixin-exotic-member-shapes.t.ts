import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1 boundary: exotic-but-legal member shapes on a mixin, in one sweep.
// - a DEFAULT parameter value (`name: string = "world"`) — an interface signature cannot carry
//   an initializer, so it must translate to an OPTIONAL parameter (`name?: string`)
// - OPTIONAL + REST parameters (`sep?: string, ...parts: string[]`)
// - a SET-ONLY accessor — modeled as a writable property (native TS models it the same way)
// - STRING-LITERAL ("my-method") and NUMERIC (0) member names
// - OPTIONAL members (`hint?: string`, `maybe?(): string`)
@mixin()
class Exotic {
    hint?: string

    0: string = "zero"

    stored: string = ""

    greet(name: string = "world"): string {
        return "hello " + name
    }

    join(sep?: string, ...parts: string[]): string {
        return parts.join(sep ?? ",")
    }

    set sink(input: string) {
        this.stored = input
    }

    "my-method"(): string {
        return "dashed"
    }

    maybe?(): string
}

class Consumer implements Exotic {
}

const consumer = new Consumer()

// Compile-time half: the default-parameter method is callable with NO argument, the optional
// member unions undefined, the exotic names exist on the type.
const greeted: string           = consumer.greet()
const hint: string | undefined  = consumer.hint
const dashed: string            = consumer["my-method"]()
const zero: string              = consumer[0]
const maybe: string | undefined = consumer.maybe?.()

// A required argument past the defaulted one still type-checks as optional-call:
// @ts-expect-error greet takes a string, not a number
consumer.greet(42)

void [ greeted, hint, dashed, zero, maybe ]

it("exotic member shapes survive into the consumer", async (t: Test) => {
    t.equal(consumer.greet(), "hello world", "the default parameter value applies through the consumer")
    t.equal(consumer.greet("mixin"), "hello mixin", "an explicit argument overrides the default")
    t.equal(consumer.join("-", "a", "b"), "a-b", "optional + rest parameters flow through")
    t.equal(consumer.join(), "", "the fully-optional call works")

    consumer.sink = "written"
    t.equal(consumer.stored, "written", "the set-only accessor fires as a real setter")

    t.equal(consumer["my-method"](), "dashed", "a string-literal-named method is callable")
    t.equal(consumer[0], "zero", "a numeric-named field is present")
    t.is(consumer.maybe, undefined, "the bodyless optional method stays absent at runtime")
})
