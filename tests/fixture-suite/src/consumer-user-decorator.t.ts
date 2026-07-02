import { mixin } from "ts-mixin-class"
import { Base } from "ts-mixin-class/base"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §2 boundary: a USER decorator on a mixin CONSUMER (the `@serializable()`-style pattern of the
// sibling ts-serializable package). The transform rewrites the consumer's heritage; the user's
// decorator must survive onto the FINAL constructor — running once, receiving a constructor that
// already carries the mixin members — and a decorated CONSTRUCTION consumer must still build
// through its generated `.new(...)`.
//
// Dual-mode decorator (this corpus compiles under both standard and legacy decorator configs):
// in both modes the first argument is the constructor.
const registered = new Map<string, Function>()

const register = (id: string) => {
    return (target: any, _context?: unknown): any => {
        registered.set(id, target as Function)

        return target
    }
}

@mixin()
class Describable {
    describe(): string {
        return "described"
    }
}

@register("plain-consumer")
class Plain implements Describable {
}

@register("construction-consumer")
class Constructed extends Base implements Describable {
    public id!: string
}

it("a user decorator on a mixin consumer", async (t: Test) => {
    t.is(registered.get("plain-consumer"), Plain, "the decorator ran once and received the final consumer constructor")
    t.equal(new Plain().describe(), "described", "the decorated consumer still carries the mixin member")
    t.equal(new (registered.get("plain-consumer") as new () => Describable)().describe(), "described",
        "the registered constructor builds instances with the mixin member (it IS the final class)")

    t.is(registered.get("construction-consumer"), Constructed, "the decorator ran on the construction consumer too")

    const built = Constructed.new({ id: "c1" })

    t.equal(built.id, "c1", "the decorated construction consumer builds through its generated .new")
    t.equal(built.describe(), "described", "and carries the mixin member")
})
