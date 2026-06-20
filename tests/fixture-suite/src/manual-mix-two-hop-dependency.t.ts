import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §5 boundary: manual `.mix(Base)` of a mixin with a TWO-hop dependency chain
// (`Top implements Mid`, `Mid implements Bottom`). The existing manual-`.mix` dependency
// fixture covers a single hop; here `.mix` must linearize and apply BOTH the direct
// dependency and its transitive dependency, threading `super` through all three, and the
// instance type must reach `Bottom`'s members through two interface-extends hops.
class UserBase {
    prefix: string

    constructor(prefix: string) {
        this.prefix = prefix
    }
}

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

class Manual extends Top.mix(UserBase) {
    combined(): string {
        return `${this.prefix}/${this.topTrace()}`
    }
}

const instance = new Manual("user")

// Bottom's member reachable through two transitive interface hops at the type level.
const reached: string = instance.trace()

it("manual .mix applies a two-hop mixin dependency transitively", async (t: Test) => {
    t.equal(instance.topTrace(), "top/mid/bottom",
        "super threads Top -> Mid -> Bottom through a manual .mix")
    t.equal(instance.combined(), "user/top/mid/bottom", "base + full chain compose")
    t.equal(reached, "bottom", "the two-hop-transitive dependency member is reachable")

    t.isInstanceOf(instance, UserBase, "instance matches the manual base")
    t.isInstanceOf(instance, Top, "instance matches the directly-mixed mixin")
    t.isInstanceOf(instance, Mid, "instance matches the first transitive dependency")
    t.isInstanceOf(instance, Bottom, "instance matches the second transitive dependency")
})

void reached
