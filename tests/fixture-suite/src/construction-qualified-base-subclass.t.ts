import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Widget } from "./construction-qualified-base.t.js"

// A CROSS-FILE subclass of an exported consumer whose construction chain runs through a
// QUALIFIED base (`Widget extends data.Model extends Base`). The construction-base
// registry must follow the qualified link when it resolves the imported `Widget`, so the
// subclass gets its own `static new` with the fully accumulated config (the qualified
// base's required `modelId` included).

class Gadget extends Widget {
    public gadgetValue?: string = ""
}

const gadget = Gadget.new({
    gadgetValue : "gv",
    modelId     : "g1",
    tag         : "x"
})

const t1: string | undefined = gadget.gadgetValue
const t2: string = gadget.modelId

// @ts-expect-error the qualified base's required key survives the cross-file registry hop.
Gadget.new({ gadgetValue: "gv" })

// @ts-expect-error the subclass config rejects unknown properties.
Gadget.new({ modelId: "g2", missing: 1 })

it("a cross-file subclass of a qualified-base consumer constructs through its own static new", (t: Test) => {
    t.isInstanceOf(gadget, Gadget, ".new returns the subclass instance")
    t.isInstanceOf(gadget, Widget, "the imported consumer stays in the runtime chain")
    t.equal(gadget.modelId, "g1", "the qualified base's required config key is assigned")
    t.equal(gadget.gadgetValue, "gv", "the subclass's own config key is assigned")
    t.equal(gadget.tagged(), "#x", "the mixin config key from the imported chain is assigned")
})

void [ t1, t2 ]
