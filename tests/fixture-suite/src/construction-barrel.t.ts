import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { BarrelBase, BarrelTagged, rankKey } from "./construction-barrel.js"

// Construction THROUGH A RE-EXPORT BARREL (§10.26): the base and the mixin are imported
// from the `export *` barrel, never from their declaring module. The registry alias keys
// keep the subclass construction-enabled, and the composed config joins the contributors'
// aliases through the barrel specifier — the computed key keeps identity and requiredness.
// The widget combines `extends <imported Base descendant>` with `implements
// <package-Base-required mixin>` deliberately: the source-view required-base check used
// to bake a false TS990014 for exactly this shape (see USE-CASES §10.27).

export class BarrelWidget extends BarrelBase implements BarrelTagged {
    public ownValue?: number = 0
}

export class BarrelNote implements BarrelTagged {
    public noteValue?: string = ""
}

const widget = BarrelWidget.new({
    baseValue : "b",
    [rankKey] : 2,
    tag       : "t",
    ownValue  : 7
})

const note = BarrelNote.new({ tag: "t", noteValue: "n" })

const w1: string = widget.baseValue
const w2: number = widget[rankKey]
const n1: string | undefined = note.tag

// @ts-expect-error the barrel-imported base's required computed key stays required.
BarrelWidget.new({ baseValue: "b" })

// @ts-expect-error the composed config rejects unknown properties.
BarrelWidget.new({ baseValue: "b", [rankKey]: 2, missing: 1 })

it("construction through an export-* barrel keeps the composed config and runtime chain", (t: Test) => {
    t.isInstanceOf(widget, BarrelWidget, ".new returns the subclass instance")
    t.isInstanceOf(widget, BarrelBase, "the barrel-imported base stays in the runtime chain")
    t.equal(widget.baseValue, "b", "the base's required key is assigned")
    t.equal(widget[rankKey], 2, "the computed key is assigned through the barrel route")
    t.equal(widget.tag, "t", "the mixin's key is assigned through the barrel route")
    t.equal(widget.ownValue, 7, "the subclass's own key is assigned")

    t.isInstanceOf(note, BarrelNote, "the barrel-imported mixin's baseless consumer constructs")
    t.equal(note.noteValue, "n", "the consumer's own key is assigned")
})

void [ w1, w2, n1 ]
