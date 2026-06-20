import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.1 boundary: a mixin method with multiple call signatures (overloads). The
// transformer copies the member into the consumer's structural interface; the consumer
// must see BOTH overloads (string -> number, number -> string), not just the
// implementation signature, and resolve each call to the right return type.
@mixin()
class Conv {
    convert(input: string): number
    convert(input: number): string
    convert(input: string | number): number | string {
        return typeof input === "string" ? input.length : `#${input}`
    }
}

class Consumer implements Conv {
    // relies on the injected overloaded member through `super`
    lengthOf(text: string): number {
        return super.convert(text)
    }

    labelOf(value: number): string {
        return super.convert(value)
    }
}

const c = new Consumer()

// Overload resolution at the call site, on the consumer instance directly.
const asNumber: number = c.convert("hello")
const asString: string = c.convert(7)

// A standalone mixin instance keeps the overloads too.
const canonical = new Conv()
const canonicalNumber: number = canonical.convert("abc")

it("mixin overloaded method", async (t: Test) => {
    t.equal(c.lengthOf("hello"), 5, "first overload (string -> number) resolves through super")
    t.equal(c.labelOf(7), "#7", "second overload (number -> string) resolves through super")
    t.equal(asNumber, 5, "consumer call site picks the string->number overload")
    t.equal(asString, "#7", "consumer call site picks the number->string overload")
    t.equal(canonicalNumber, 3, "standalone mixin instance keeps both overloads")
})

void [ asNumber, asString, canonicalNumber ]
