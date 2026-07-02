import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// A USER decorator on a `@mixin` CLASS (the ts-serializable `@serializable()` pattern —
// §2.8's mixin twin): applies ONCE, to the mixin VALUE the user holds — consumers compose
// through the factory and are not re-decorated. Rest-args + void keeps the decorator shape
// valid for BOTH modes (standard receives (value, context), legacy receives (target)); in
// standard mode the value is built through an IIFE-wrapped real class declaration so the
// compiler emits the TC39 machinery itself, in legacy mode through a plain value fold.

let decorated = 0
let received: unknown

// The FIRST argument is the decorated class in both modes (standard: `value`, legacy:
// `target`) — captured to assert IDENTITY with the top-level `Stamped` binding below: the
// decorator runs on exactly the constructor the user ends up holding, not on a hidden layer.
function audit(...args: unknown[]): void {
    decorated += 1
    received = args[0]
}

@mixin()
@audit
class Stamped {
    stamp: string = "stamped"

    describe(): string {
        return `stamp:${this.stamp}`
    }
}

class Card implements Stamped {
}

class Badge implements Stamped {
}

const card  = new Card()
const badge = new Badge()

it("a user decorator on a @mixin class", (t: Test) => {
    t.equal(decorated, 1, "the class decorator runs ONCE — on the value, not per application")
    t.is(received, Stamped, "the decorator received the very constructor the user holds as `Stamped`")

    t.equal(new Stamped().describe(), "stamp:stamped", "the mixin instantiates standalone through the decorated value")
    t.equal(card.describe(), "stamp:stamped", "a consumer composes normally")
    t.equal(badge.describe(), "stamp:stamped", "…and a second consumer too")

    t.true(card instanceof Stamped, "instanceof rides the marker through the decorated value")
    t.equal(Stamped.name, "Stamped", "the user-held value keeps the real class name")
})
