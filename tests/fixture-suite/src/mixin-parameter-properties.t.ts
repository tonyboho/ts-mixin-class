import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1 boundary: PARAMETER PROPERTIES in a mixin's own constructor
// (`constructor(public label: string = "x")`). They declare real instance members, so they
// must reach the generated mixin interface like ordinary property declarations do — otherwise
// the runtime instance carries the member while the type silently denies it (TS2339 on the
// consumer). Defaults are required: the consumer chain calls the constructor without arguments.
@mixin()
class Stamped {
    constructor(
        public label: string = "unstamped",
        public readonly serial: number = 0
    ) {}

    describe(): string {
        return this.label + "#" + String(this.serial)
    }
}

class Consumer implements Stamped {
}

const consumer = new Consumer()

// The members exist ON THE TYPE (this line is the compile-time half of the spec).
const label: string  = consumer.label
const serial: number = consumer.serial

// `readonly` survives onto the generated interface member. Type-only check: readonly is
// erased at runtime, so the violating assignment must never actually execute.
function readonlyIsEnforced(instance: Stamped): void {
    // @ts-expect-error serial is readonly
    instance.serial = 1
}

void [ label, serial, readonlyIsEnforced ]

it("parameter properties of a mixin constructor become interface members", async (t: Test) => {
    t.equal(consumer.label, "unstamped", "the parameter property default is assigned at runtime")
    t.is(consumer.serial, 0, "the readonly parameter property is assigned at runtime")
    t.equal(consumer.describe(), "unstamped#0", "a mixin method reads the parameter properties")

    const standalone = new Stamped("direct", 7)

    t.equal(standalone.describe(), "direct#7", "standalone construction passes constructor arguments")
})
