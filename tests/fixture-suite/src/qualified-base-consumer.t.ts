import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// A QUALIFIED base (`extends data.Model`) resolved through a local namespace, combined
// with a GENERIC consumer and a generic mixin — the navigable-base fast path's hardest
// non-construction shape: the qualified chain is pinned per token, the consumer's type
// parameter threads through the cast's generic construct signature, and the runtime
// chain must construct through the namespace value. (`data.Model` here does NOT extend
// the package `Base`, so this stays a manually-constructed, non-construction consumer —
// the construction twin is `construction-qualified-base.t.ts`.)

namespace data {
    export class Model {
        modelValue: number = 0
    }
}

@mixin()
class Holder<V> {
    stored: V | undefined = undefined

    take(): V | undefined {
        return this.stored
    }
}

class Widget<T> extends data.Model implements Holder<T> {
    grab(): T | undefined {
        return super.take()
    }
}

const widget = new Widget<string>()

widget.stored = "held"

const t1: string | undefined = widget.grab()
const t2: number = widget.modelValue

// @ts-expect-error Widget<string> fixes the mixin value to string.
const e1: number | undefined = widget.grab()

// @ts-expect-error the base field stays number through the qualified chain.
const e2: string = widget.modelValue

void t1
void t2
void e1
void e2

it("a generic consumer of a qualified base builds and threads its type parameter", (t: Test) => {
    t.equal(widget.grab(), "held", "the generic mixin member threads through super")
    t.equal(widget.modelValue, 0, "the qualified base's field is inherited")
    t.true(widget instanceof data.Model, "runtime chain goes through the namespace value")
})
