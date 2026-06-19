import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §6 boundary: generic mixins with the trickier type-parameter shapes the cloning paths
// must preserve verbatim — **multiple** parameters, a **constraint** (`K extends string`),
// and a **default** (`V = number`). Every original fixture used a single, unconstrained,
// undefaulted parameter; a regression that reconstructs type parameters by hand (instead of
// deep-cloning) would silently drop the constraint or default and only this notices. (The
// defaulted param also exercises the `.mix` signature fix — §6.5 — at runtime; the
// compile-only spec is `tests/generic-mixin-defaulted-type-param.t.ts`.)
@mixin()
class Keyed<K extends string, V = number> {
    key!: K
    value!: V

    describe(): string {
        return `${this.key}=${String(this.value)}`
    }
}

// Consumer fixing both params explicitly.
class FixedEntry implements Keyed<"id", boolean> {
}

// Consumer relying on the defaulted V (resolves to number).
class DefaultedEntry implements Keyed<"count"> {
}

// Consumer *forwarding* a constrained parameter (exercises own-type-parameter erasure
// while keeping the `extends string` constraint on the consumer side).
class Wrapper<K extends string> implements Keyed<K, string> {
    wrapped(): string {
        return this.describe()
    }
}

const fixed = new FixedEntry()
fixed.key   = "id"
fixed.value = true

const wrapper = new Wrapper<"k">()
wrapper.key   = "k"
wrapper.value = "v"

const defaulted = new DefaultedEntry()
defaulted.key   = "count"
defaulted.value = 7 // V defaulted to number

const k1: "id" = fixed.key
const v1: boolean = fixed.value
const v3: string = wrapper.value
const v4: number = defaulted.value

// Type-only negative checks (never executed).
function typeOnlyChecks(): void {
    // @ts-expect-error the first param is fixed to the literal "id".
    fixed.key = "other"

    // @ts-expect-error value is fixed to boolean on this consumer.
    fixed.value = "not a boolean"

    // @ts-expect-error V defaulted to number rejects a string.
    defaulted.value = "not a number"
}
void typeOnlyChecks

// @ts-expect-error number does not satisfy `K extends string`.
type BadKey = Keyed<number, unknown>
void (undefined as unknown as BadKey)

it("supports multi-param, constrained, and defaulted generic mixins", async (t: Test) => {
    t.equal(fixed.describe(), "id=true", "explicit two-param mixin composes")
    t.equal(wrapper.wrapped(), "k=v", "constrained forwarded param works through a consumer")
    t.equal(defaulted.describe(), "count=7", "defaulted type param works at runtime")

    t.isInstanceOf(fixed, Keyed, "fixed consumer matches the generic mixin")
    t.isInstanceOf(wrapper, Keyed, "forwarding consumer matches the generic mixin")
    t.isInstanceOf(defaulted, Keyed, "defaulted-param consumer matches the generic mixin")
})

void [ k1, v1, v3, v4 ]
