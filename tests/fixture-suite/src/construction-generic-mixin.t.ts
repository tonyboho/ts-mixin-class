import { Base, mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §7 × §6: a GENERIC construction-base mixin — the standalone `.new<T>` (explicit or inferred
// from the config), a consumer fixing the parameter, defaults and `initialize` protocol at
// runtime. (The type-plane pins live in tests/construction-generic-mixin.t.ts.)
@mixin()
class Stash<T> extends Base {
    public item!: T

    public label: string = "stash"

    describe(): string {
        return `${this.label}:${String(this.item)}`
    }
}

class NumberStash implements Stash<number> {
    doubled(): number {
        return this.item * 2
    }
}

const explicit = Stash.new<Date>({ item: new Date(0), label: "dates" })
const inferred = Stash.new({ item: 42 })
const fixed    = NumberStash.new({ item: 7 })

// Compile-time half: the instance types carry the bound parameter.
const explicitItem: Date   = explicit.item
const inferredItem: number = inferred.item
const fixedItem: number    = fixed.item

void [ explicitItem, inferredItem, fixedItem ]

function typeOnlyChecks(): void {
    // @ts-expect-error the required config key is enforced per instantiation
    Stash.new<Date>({ label: "missing item" })

    // @ts-expect-error the config key is typed by the fixed parameter
    Stash.new<Date>({ item: 5 })

    // @ts-expect-error direct new is banned — construction goes through .new
    new Stash<Date>()
}
void typeOnlyChecks

it("generic construction mixin", async (t: Test) => {
    t.equal(explicit.item.getTime(), 0, "the explicitly-typed config value is assigned")
    t.equal(explicit.label, "dates", "an explicit config value overrides the default")

    t.equal(inferred.item, 42, "the inferred instantiation assigns the config value")
    t.equal(inferred.label, "stash", "an omitted optional key keeps the initializer default")
    t.equal(inferred.describe(), "stash:42", "the mixin's own method sees the configured state")

    t.equal(fixed.item, 7, "a consumer fixing the parameter constructs through its own .new")
    t.equal(fixed.doubled(), 14, "…and its own members compose with the mixin's config")

    t.equal(fixed instanceof Base, true, "the consumer instance sits on the construction chain")
    t.equal(fixed instanceof NumberStash, true, "instanceof matches the consumer itself")
    t.equal(explicit instanceof Stash, true, "the standalone instance matches the mixin class")
})
