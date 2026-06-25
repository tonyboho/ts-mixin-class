import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// A NONTRIVIAL (interleaved) diamond, the case the precomputed-linearization optimization
// (approach B) must preserve and that plain concatenation cannot produce. Two diamonds share
// A: D pulls in [B, C] (both over A) and F adds E (also over A). C3 delays the shared A past
// E, so the resolution order interleaves E between C and A: F > D > B > C > E > A. Each mixin
// prepends its name and calls super.who(), so the printed string is the exact runtime chain.
//
// This lives in the fixture corpus on purpose: it is built and run with the runtime
// linearization cross-check ON BY DEFAULT, so every plan replay here is asserted equal to C3
// as the suite runs, and the mixin sites feed the language-server stress tests.
@mixin()
class A {
    who(): string {
        return "A"
    }
}

@mixin()
class B implements A {
    who(): string {
        return "B>" + super.who()
    }
}

@mixin()
class C implements A {
    who(): string {
        return "C>" + super.who()
    }
}

@mixin()
class D implements B, C {
    who(): string {
        return "D>" + super.who()
    }
}

@mixin()
class E implements A {
    who(): string {
        return "E>" + super.who()
    }
}

@mixin()
class F implements D, E {
    who(): string {
        return "F>" + super.who()
    }
}

class Consumer implements F {
}

const c = new Consumer()

it("mixin interleaved diamond", async (t: Test) => {
    t.equal(c.who(), "F>D>B>C>E>A",
        "the interleaved diamond resolves in C3 order with E between C and A")
    t.isInstanceOf(c, A, "the consumer matches the shared transitive mixin A")
    t.isInstanceOf(c, E, "the consumer matches the interleaved mixin E")
    t.isInstanceOf(c, F, "the consumer matches the direct mixin F")
})
