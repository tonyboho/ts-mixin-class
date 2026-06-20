import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §2 / §11.5 boundary: two INDEPENDENT mixins that each declare the SAME-named instance method
// with a COMPATIBLE signature. Unlike a STATIC collision (§11.5, which is diagnosed), an
// instance-member overlap with identical signatures must MERGE cleanly into the consumer's
// interface (no TS2320) and stay callable; at runtime the FIRST-listed mixin in `implements`
// wins deterministically (here `Greeter` -> "hello"), per C3 linearization order.
@mixin()
class Greeter {
    greet(): string {
        return "hello"
    }
}

@mixin()
class Farewell {
    greet(): string {
        return "bye"
    }
}

class Polite implements Greeter, Farewell {
}

const p = new Polite()

const result: string = p.greet()

it("mixin shared instance member merges cleanly", async (t: Test) => {
    t.equal(result, "hello",
        "a same-named instance method merges into the consumer; the FIRST-listed mixin (Greeter) wins")
})

void result
