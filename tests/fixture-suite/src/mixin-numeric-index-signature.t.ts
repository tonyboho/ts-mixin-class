import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §11.7 boundary: a NUMERIC index signature (`[index: number]: T`), not the string one
// the existing index-signature fixtures cover. A consumer must gain a number-indexed
// dynamic member shape; like the string case it is type-only and erased at runtime, so
// numeric keys read/write as plain own properties.
@mixin()
class Row {
    [column: number]: string

    name: string = "row"
}

class Record implements Row {
    name: string = "record"
}

const r = new Record()
r[0] = "first"
r[1] = "second"

const cell: string = r[0]

it("mixin numeric index signature", async (t: Test) => {
    t.equal(r.name, "record", "declared member coexists with the numeric index signature")
    t.equal(r[0], "first", "numeric key reads/writes at runtime (index sig erased)")
    t.equal(r[1], "second", "a second numeric key is an ordinary own property")
    t.equal(cell, "first", "the numeric index signature resolves to the value type at the consumer")
})

void cell
