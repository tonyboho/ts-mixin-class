import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §11.7 boundary: an index signature whose VALUE type is the mixin's own type parameter
// (`[key: string]: V`). A consumer that fixes the parameter (`implements Bag<string>`)
// must gain a string-valued dynamic member shape; the index signature is type-only and
// erased at runtime, so arbitrary keys read/write as plain own properties.
@mixin()
class Bag<V> {
    [key: string]: V | string

    label: string = "bag"
}

class StringBag implements Bag<string> {
    label: string = "strings"
}

const b = new StringBag()
b["anything"] = "value"

const dynamic: string = b["anything"]

it("mixin generic index signature", async (t: Test) => {
    t.equal(b.label, "strings", "declared member coexists with the index signature")
    t.equal(b["anything"], "value", "arbitrary string key reads/writes at runtime (index sig erased)")
    t.equal(dynamic, "value", "the index signature resolves the parameter to the consumer's string argument")
})

void dynamic
