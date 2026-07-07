import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { mixin } from "ts-mixin-class"

import { Widget } from "./construction-qualified-base.t.js"

// A local qualified chain that passes through an IMPORTED intermediate base:
// `Leaf extends wrap.Mid` where the namespace-nested `Mid` extends the imported
// construction base `Widget`. In-file recognition follows the whole chain (the gates
// carry the cross-file context), and the construction-base REGISTRY must too — its
// local walk hands the chain's exit (`Widget`) to the ordinary imported-candidate
// resolution — so a subclass of the exported `Leaf` in another file keeps the fully
// accumulated config (see the subclass twin fixture).

@mixin()
class Labeled {
    public label?: string = ""
}

namespace wrap {
    export class Mid extends Widget {
        public midValue?: number = 0
    }
}

export class Leaf extends wrap.Mid implements Labeled {
    public leafValue?: string = ""
}

const leaf = Leaf.new({
    label     : "l",
    leafValue : "lv",
    midValue  : 5,
    modelId   : "m1",
    tag       : "t"
})

const t1: string = leaf.modelId
const t2: number | undefined = leaf.midValue
const t3: string | undefined = leaf.leafValue

// @ts-expect-error the chain's required key survives the imported intermediate hop.
Leaf.new({ leafValue: "lv" })

// @ts-expect-error the config rejects unknown properties.
Leaf.new({ modelId: "m2", missing: 1 })

it("a consumer whose qualified chain passes through an imported base constructs in-file", (t: Test) => {
    t.isInstanceOf(leaf, Leaf, ".new returns the consumer instance")
    t.isInstanceOf(leaf, wrap.Mid, "the nested intermediate stays in the runtime chain")
    t.isInstanceOf(leaf, Widget, "the imported base stays in the runtime chain")
    t.equal(leaf.modelId, "m1", "the required key from the imported tail is assigned")
    t.equal(leaf.midValue, 5, "the nested intermediate's config key is assigned")
    t.equal(leaf.leafValue, "lv", "the consumer's own config key is assigned")
    t.equal(leaf.label, "l", "the local mixin's config key is assigned")
})

void [ t1, t2, t3 ]
