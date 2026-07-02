import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// The stress-corpus plane of the pass-7 accessor pins: a consumer accessor override reaching
// the mixin's accessor through `super` (§2.17), `this`-typed accessor SHAPES riding the
// property-signature fallback (§1.33 — the TS 6.0 interface-accessor crash workaround), and a
// SYMBOL-named accessor (§1.34). Living here feeds navigation / rename / quickinfo sweeps.

@mixin()
class Measured {
    stored: number = 10

    get value(): number {
        return this.stored
    }

    set value(input: number) {
        this.stored = input
    }
}

class Doubling implements Measured {
    get value(): number {
        return super.value * 2
    }

    set value(input: number) {
        super.value = input
    }
}

@mixin()
class Linked {
    stored: this | undefined

    get self(): this {
        return this
    }

    get pair(): [this, string] {
        return [ this as this, "tag" ]
    }

    set other(value: this) {
        this.stored = value
    }
}

class Chain implements Linked {
    own(): string {
        return "own"
    }
}

@mixin()
class Tagged {
    named: string = "tagged"

    get [Symbol.toStringTag](): string {
        return this.named
    }
}

class Item implements Tagged {
}

it("a consumer accessor override reaches the mixin's accessor through super", (t: Test) => {
    const doubling = new Doubling()

    doubling.value = 5

    t.equal(doubling.stored, 5, "the setter delegates through super")
    t.equal(doubling.value, 10, "the getter doubles through super")
})

it("this-typed accessor shapes narrow to the consumer (property-signature fallback)", (t: Test) => {
    const chain = new Chain()

    chain.other = new Chain()

    const paired: [Chain, string] = chain.pair

    t.equal(paired[0].own(), "own", "the nested this type narrowed to Chain")
    t.equal(chain.self.own(), "own", "the plain this getter narrows too")
    t.equal(chain.stored?.own(), "own", "the this-typed setter stored a Chain")
})

it("a symbol-named accessor drives Object.prototype.toString", (t: Test) => {
    const item = new Item()

    t.equal(item[Symbol.toStringTag], "tagged", "the well-known symbol getter is a typed member")
    t.equal(Object.prototype.toString.call(item), "[object tagged]", "…and the runtime honors it")
})
