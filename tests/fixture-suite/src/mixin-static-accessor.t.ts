import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.1 / §6.2 boundary: a mixin's STATIC accessor (get/set pair), not just a static
// method or field. Static members are inherited onto the consumer; the accessor must
// surface as a real static accessor (the getter computes, the setter mutates shared
// static state) on both the consumer and a standalone mixin instance's constructor.
@mixin()
class Counter {
    static _count: number = 0

    static get count(): number {
        return Counter._count
    }

    static set count(value: number) {
        Counter._count = value
    }

    bump(): void {
        Counter.count = Counter.count + 1
    }
}

class Consumer implements Counter {
}

it("mixin static accessor", async (t: Test) => {
    Counter.count = 0

    const c = new Consumer()
    c.bump()
    c.bump()

    // The static accessor is reachable as a static on the consumer's constructor.
    t.equal((Consumer as unknown as typeof Counter).count, 2,
        "static getter on the consumer reads the shared static state mutated via the setter")

    // And on the mixin itself.
    ;(Consumer as unknown as typeof Counter).count = 10
    t.equal(Counter.count, 10, "static setter reachable through the consumer writes the shared state")
})
