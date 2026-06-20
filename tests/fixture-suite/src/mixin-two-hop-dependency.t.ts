import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.4 / §3.2 boundary: a TWO-hop mixin dependency chain (Top depends on Mid, Mid
// depends on Bottom). Existing coverage exercises a single hop; here a consumer that
// `implements Top` must receive Bottom's members transitively AND the runtime `super`
// chain must thread Top -> Mid -> Bottom in C3 order so `super.topMethod()` cascades all
// the way down.
@mixin()
class Bottom {
    bottomValue: string = "bottom"

    trace(): string {
        return this.bottomValue
    }
}

@mixin()
class Mid implements Bottom {
    bottomValue: string = "bottom"

    trace(): string {
        return this.bottomValue
    }

    midTrace(): string {
        return "mid/" + super.trace()
    }
}

@mixin()
class Top implements Mid {
    bottomValue: string = "bottom"

    trace(): string {
        return this.bottomValue
    }

    midTrace(): string {
        return "mid/" + super.trace()
    }

    topTrace(): string {
        return "top/" + super.midTrace()
    }
}

class Consumer implements Top {
    run(): string {
        return super.topTrace()
    }
}

const c = new Consumer()

// Bottom's member is reachable on the consumer at the type level through two hops.
const reached: string = c.trace()

it("mixin two-hop dependency", async (t: Test) => {
    t.equal(c.run(), "top/mid/bottom",
        "super chain threads Top -> Mid -> Bottom transitively at runtime")
    t.equal(reached, "bottom", "the two-hop-transitive member is present on the consumer")
})

void reached
