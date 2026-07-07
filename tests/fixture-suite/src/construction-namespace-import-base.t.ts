import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import * as lib from "./construction-qualified-base.t.js"

// A NAMESPACE-IMPORT construction base: `Panel extends lib.Widget` where `lib` is a
// namespace import of another module and `Widget` is a registered construction base
// there (itself construction-enabled through a qualified local-namespace chain). The
// dotted reference resolves through the namespace binding into the cross-file
// construction-base registry, so the consumer gets its own `static new` with the fully
// accumulated config (the chain's required `modelId` included). Note this file imports
// nothing from the package itself — recognition rides entirely on the registry.

export class Panel extends lib.Widget {
    public panelValue?: string = ""
}

const panel = Panel.new({
    modelId    : "p1",
    panelValue : "pv",
    tag        : "pt"
})

const t1: string = panel.modelId
const t2: string | undefined = panel.panelValue
const t3: string | undefined = panel.tag

// @ts-expect-error the chain's required key survives the namespace-import hop.
Panel.new({ panelValue: "pv" })

// @ts-expect-error the config rejects unknown properties.
Panel.new({ modelId: "p2", missing: 1 })

it("a consumer of a namespace-import construction base constructs through its own static new", (t: Test) => {
    t.isInstanceOf(panel, Panel, ".new returns the consumer instance")
    t.isInstanceOf(panel, lib.Widget, "the imported base stays in the runtime chain")
    t.equal(panel.modelId, "p1", "the chain's required config key is assigned")
    t.equal(panel.panelValue, "pv", "the consumer's own config key is assigned")
    t.equal(panel.tagged(), "#pt", "the mixin config key from the imported chain is assigned")
})

void [ t1, t2, t3 ]
