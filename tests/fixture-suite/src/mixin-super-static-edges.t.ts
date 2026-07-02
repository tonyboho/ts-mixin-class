import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// Super/static edges through the heritage rewrite: a consumer STATIC reaching the mixin's
// static through `super` (§2.24 — legal only because both planes give the base-less consumer
// a real base), `super` from an instance ARROW-FUNCTION field initializer, a SYMBOL-keyed
// STATIC on a mixin (§1.35 — the static twin of §1.17), and a consumer field initialized from
// ANOTHER mixin's field (§3.5 — base-most-first order makes the read safe).

const kind: unique symbol = Symbol("kind")

@mixin()
class Registry {
    static describe(): string {
        return "registry"
    }

    static [kind](): string {
        return "tagged-static"
    }

    entry: string = "e"
}

class Store implements Registry {
    static describe(): string {
        return super.describe() + "/store"
    }
}

@mixin()
class Greeter {
    greet(): string {
        return "hi"
    }
}

class Worker implements Greeter {
    loud = (): string => super.greet().toUpperCase()
}

@mixin()
class Amounts {
    amount: number = 10
}

@mixin()
class Doubles {
    doubled: number = 0
}

class Item implements Doubles, Amounts {
    // Consumer fields initialize LAST (base-most first — §3.4), so this reads amount=10.
    total: number = this.amount + 1
}

it("a consumer STATIC method reaches the mixin's static through super", (t: Test) => {
    t.equal(Store.describe(), "registry/store", "the static super call threads into the mixin layer")
})

it("a SYMBOL-keyed static on a mixin is typed and inherited", (t: Test) => {
    t.equal(Registry[kind](), "tagged-static", "callable on the mixin")
    t.equal((Store as unknown as typeof Registry)[kind](), "tagged-static", "inherited by the consumer constructor")
})

it("super from an arrow-function FIELD initializer", (t: Test) => {
    t.equal(new Worker().loud(), "HI", "the home object of the field arrow is the consumer prototype")
})

it("a consumer field initialized from ANOTHER mixin's field", (t: Test) => {
    const item = new Item()

    t.equal(item.total, 11, "the cross-mixin initializer read sees the initialized value")
    t.equal(item.amount, 10, "the source field is intact")
})
