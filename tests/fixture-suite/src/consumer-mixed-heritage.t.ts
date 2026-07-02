import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §2 boundary: a consumer implementing a MIXIN and a PLAIN interface side by side
// (`implements Greeter, Nameable`). The transform must apply the mixin while LEAVING the plain
// interface as an ordinary type contract — still required of the class body.
interface Nameable {
    name(): string
}

@mixin()
class Greeter {
    greet(): string {
        return "hi"
    }
}

class Both implements Greeter, Nameable {
    name(): string {
        return "both"
    }
}

// The plain-interface contract is still ENFORCED — a consumer that omits the member fails:
// @ts-expect-error Nameable.name is required and not provided by the mixin
class Missing implements Greeter, Nameable {
}

// Degenerate-but-tolerated: the SAME mixin listed twice applies once (memoized), no type error.
class Doubled implements Greeter, Greeter {
}

const both = new Both()

it("a consumer with a mixin and a plain interface side by side", async (t: Test) => {
    t.equal(both.greet(), "hi", "the mixin member is applied")
    t.equal(both.name(), "both", "the plain-interface member is the class's own")
    t.true(both instanceof Greeter, "instanceof matches the mixin")
})

it("the same mixin listed twice applies once", async (t: Test) => {
    const doubled = new Doubled()

    t.equal(doubled.greet(), "hi", "the member is present")
    t.true(doubled instanceof Greeter, "instanceof matches")
})

void Missing
