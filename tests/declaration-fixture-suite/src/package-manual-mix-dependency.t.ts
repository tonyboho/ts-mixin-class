import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Bottom, Mid, Top } from "ts-mixin-class-fixture-suite/mixins"

// §5 boundary (relocated from the fixture-suite when program-local `.mix` became
// TS990012): manual `.mix(Base)` of a DECLARATION mixin that itself depends on other
// mixins. `.mix` must linearize and apply the dependencies transitively
// (`mixinChain` -> `linearizeRuntimeRequirements`), thread `super` through every
// layer, and the instance type must reach the dependencies' members through the
// interface-extends hops of the published declarations.
class UserBase {
    prefix: string

    constructor(prefix: string) {
        this.prefix = prefix
    }
}

// ONE hop: `Mid implements Bottom`.
class ManualWithDependency extends Mid.mix(UserBase) {
    combined(): string {
        return `${this.prefix}/${this.midTrace()}/${this.trace()}`
    }
}

const oneHop = new ManualWithDependency("user")

const t1: string = oneHop.prefix
const t2: string = oneHop.midTrace()
// The dependency's member is reachable through the type, not only at runtime.
const t3: string = oneHop.trace()
const t4: string = oneHop.bottomValue

it("manual .mix applies and types a declaration mixin dependency transitively", async (t: Test) => {
    t.equal(oneHop.trace(), "bottom", "transitively-applied dependency method runs")
    t.equal(oneHop.midTrace(), "mid/bottom", "the dependent mixin's super reaches the dependency")
    t.equal(oneHop.combined(), "user/mid/bottom/bottom", "base + mixin + dependency all compose")

    t.isInstanceOf(oneHop, UserBase, "instance matches the manual base")
    t.isInstanceOf(oneHop, Mid, "instance matches the directly-mixed mixin")
    t.isInstanceOf(oneHop, Bottom, "instance matches the transitively-applied dependency mixin")
})

// TWO hops: `Top implements Mid`, `Mid implements Bottom`.
class ManualTwoHop extends Top.mix(UserBase) {
    combined(): string {
        return `${this.prefix}/${this.topTrace()}`
    }
}

const twoHop = new ManualTwoHop("user")

// Bottom's member reachable through two transitive interface hops at the type level.
const reached: string = twoHop.trace()

it("manual .mix applies a two-hop declaration-mixin dependency transitively", async (t: Test) => {
    t.equal(twoHop.topTrace(), "top/mid/bottom",
        "super threads Top -> Mid -> Bottom through a manual .mix")
    t.equal(twoHop.combined(), "user/top/mid/bottom", "base + full chain compose")
    t.equal(reached, "bottom", "the two-hop-transitive dependency member is reachable")

    t.isInstanceOf(twoHop, UserBase, "instance matches the manual base")
    t.isInstanceOf(twoHop, Top, "instance matches the directly-mixed mixin")
    t.isInstanceOf(twoHop, Mid, "instance matches the first transitive dependency")
    t.isInstanceOf(twoHop, Bottom, "instance matches the second transitive dependency")
})

void [ t1, t2, t3, t4, reached ]
