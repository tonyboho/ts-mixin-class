import { Base, mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// Required-base and dependency STATICS reached from a mixin's own static through `super` —
// the factory's `base` parameter carries the base's static side, so this type-checks on the
// emit plane (it always did in source view) AND resolves correctly at runtime: `super` in a
// static body is the applied runtime base, which inherits the required base's / dependency's
// statics through the chain.

class Persisted {
    static hello(): string {
        return "hello"
    }

    id: number = 0
}

@mixin()
class Stored extends Persisted {
    key: string = "k"

    static greetViaBase(): string {
        return `${super.hello()}!`
    }
}

class StoredUser extends Persisted implements Stored {
}

// The TODO's motivating case: a mixin's own `static new` factory delegating to `Base.new`.
@mixin()
class Titled extends Base {
    public title: string = ""

    static new(title: string): Titled {
        return super.new({ title }) as Titled
    }
}

// A dependency's statics through `super`: the applied chain inherits them below the mixin.
@mixin()
class Counter {
    static origin(): string {
        return "counter"
    }

    count: number = 1
}

@mixin()
class Doubler implements Counter {
    static originViaDep(): string {
        return `via:${super.origin()}`
    }

    double(): number {
        return this.count * 2
    }
}

class DoublerUser implements Doubler {
}

it("a mixin's static reaches base and dependency statics through super", (t: Test) => {
    t.equal(Stored.greetViaBase(), "hello!", "required-base static via super, on the mixin value")
    t.equal(new StoredUser().key, "k", "…and the consumer still composes")

    const titled = Titled.new("spec")

    t.equal(titled.title, "spec", "the mixin's own static new delegates to Base.new via super")
    t.true(titled instanceof Titled, "…and the delegated instance rides the mixin marker")

    t.equal(Doubler.originViaDep(), "via:counter", "dependency static via super, on the mixin value")
    t.equal(new DoublerUser().double(), 2, "…and the dependent consumer still composes")
})
