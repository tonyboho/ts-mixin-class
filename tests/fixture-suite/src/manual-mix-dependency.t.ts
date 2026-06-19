import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §5 boundary: manual `.mix(Base)` of a mixin that itself **depends** on another mixin
// (`@mixin() Main implements Dep`). The existing `.mix` fixtures only apply independent
// mixins; this pins the combination where `.mix` must linearize and apply the dependency
// transitively (`mixinChain` -> `linearizeRuntimeRequirements`), and the result is typed
// through `Main`'s interface (which `extends Dep`), so `Dep`'s members are reachable.
class UserBase {
    prefix: string

    constructor(prefix: string) {
        this.prefix = prefix
    }
}

@mixin()
class Dep {
    depValue: string = "dep"

    depMethod(): string {
        return this.depValue
    }
}

@mixin()
class Main implements Dep {
    mainMethod(): string {
        return "main/" + super.depMethod()
    }
}

class ManualWithDependency extends Main.mix(UserBase) {
    combined(): string {
        return `${this.prefix}/${this.mainMethod()}/${this.depMethod()}`
    }
}

const instance = new ManualWithDependency("user")

const t1: string = instance.prefix
const t2: string = instance.mainMethod()
// The dependency's member is reachable through the type, not only at runtime.
const t3: string = instance.depMethod()
const t4: string = instance.depValue

it("manual .mix applies and types a mixin dependency transitively", async (t: Test) => {
    t.equal(instance.depMethod(), "dep", "transitively-applied dependency method runs")
    t.equal(instance.mainMethod(), "main/dep", "dependent mixin's super reaches the dependency")
    t.equal(instance.combined(), "user/main/dep/dep", "base + mixin + dependency all compose")

    t.isInstanceOf(instance, UserBase, "instance matches the manual base")
    t.isInstanceOf(instance, Main, "instance matches the directly-mixed mixin")
    t.isInstanceOf(instance, Dep, "instance matches the transitively-applied dependency mixin")
})

void [ t1, t2, t3, t4 ]
