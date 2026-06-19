import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §6 boundary: generic mixins with the trickier type-parameter shapes the cloning paths
// must preserve verbatim — **multiple** parameters and a **constraint** (`K extends
// string`). Every fixture so far used a single, unconstrained parameter; a regression
// that reconstructs type parameters by hand (instead of deep-cloning) would silently drop
// the constraint and only this notices.
//
// NOTE: a *defaulted* type parameter (`<V = number>`) is intentionally NOT exercised here
// — it currently fails to compile (TS2706) because the generated `.mix` signature appends
// a required `__MixinBase` after the mixin's own params. Tracked separately as a known gap.
@mixin()
class Keyed<K extends string, V> {
    key!: K
    value!: V

    describe(): string {
        return `${this.key}=${String(this.value)}`
    }
}

// Consumer fixing both params explicitly.
class FixedEntry implements Keyed<"id", boolean> {
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

const k1: "id" = fixed.key
const v1: boolean = fixed.value
const v3: string = wrapper.value

// Type-only negative checks (never executed).
function typeOnlyChecks(): void {
    // @ts-expect-error the first param is fixed to the literal "id".
    fixed.key = "other"

    // @ts-expect-error value is fixed to boolean on this consumer.
    fixed.value = "not a boolean"
}
void typeOnlyChecks

// @ts-expect-error number does not satisfy `K extends string`.
type BadKey = Keyed<number, unknown>
void (undefined as unknown as BadKey)

it("supports multi-param and constrained generic mixins", async (t: Test) => {
    t.equal(fixed.describe(), "id=true", "explicit two-param mixin composes")
    t.equal(wrapper.wrapped(), "k=v", "constrained forwarded param works through a consumer")

    t.isInstanceOf(fixed, Keyed, "fixed consumer matches the generic mixin")
    t.isInstanceOf(wrapper, Keyed, "forwarding consumer matches the generic mixin")
})

void [ k1, v1, v3 ]
