import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.30: an AUTO-ACCESSOR (the `accessor` keyword, TS 4.9) on a mixin. Syntactically a
// PropertyDeclaration, but at runtime a real get/set pair on the declaring prototype, backed
// by a per-instance private slot — so on a consumer the member must behave as an ACCESSOR
// (no own data property on the instance), with independent per-instance state, standalone
// and through the chain.
@mixin()
class Counted {
    accessor count: number = 0

    bump(): number {
        this.count += 1
        return this.count
    }
}

class Clicker implements Counted {
}

function inheritedDescriptor(instance: object, name: string): PropertyDescriptor | undefined {
    for (let proto = Object.getPrototypeOf(instance); proto !== null; proto = Object.getPrototypeOf(proto)) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, name)

        if (descriptor !== undefined) {
            return descriptor
        }
    }

    return undefined
}

const clicker = new Clicker()

// Compile-time half: the member reads and writes as `number` on the consumer.
const initial: number = clicker.count

clicker.count = initial

it("mixin auto-accessor member", async (t: Test) => {
    t.equal(clicker.count, 0, "the auto-accessor initializer applies on the consumer")
    t.equal(clicker.bump(), 1, "the mixin's method mutates through its own auto-accessor")

    clicker.count = 10
    t.equal(clicker.count, 10, "assignment through the consumer fires the generated setter")

    t.equal(new Clicker().count, 0, "the backing slot is per-instance, not shared")
    t.equal(new Counted().count, 0, "the mixin still instantiates standalone")

    t.is(Object.getOwnPropertyDescriptor(clicker, "count"), undefined,
        "no own data property on the instance — the member is a real accessor")

    const descriptor = inheritedDescriptor(clicker, "count")

    t.eq(typeof descriptor?.get, "function", "a getter lives on the prototype chain")
    t.eq(typeof descriptor?.set, "function", "…paired with a setter")
})
