import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Leaf } from "./construction-qualified-imported-chain.t.js"

// The cross-file twin of `construction-qualified-imported-chain`: subclassing the
// exported `Leaf`, whose construction chain runs `Leaf -> wrap.Mid (local namespace) ->
// Widget (imported) -> data.Model (its local namespace) -> Base`. The registry entry
// for `Leaf` must carry the WHOLE accumulated config, i.e. its local walk must hand the
// chain's imported exit to the candidate resolution instead of dead-ending.

class Twig extends Leaf {
    public twigValue?: boolean = false
}

const twig = Twig.new({
    label     : "l",
    midValue  : 3,
    modelId   : "t1",
    twigValue : true
})

const t1: string = twig.modelId
const t2: boolean | undefined = twig.twigValue

// @ts-expect-error the chain's required key survives the registry hop.
Twig.new({ twigValue: true })

// @ts-expect-error the subclass config rejects unknown properties.
Twig.new({ modelId: "t2", missing: 1 })

it("a cross-file subclass of an imported-chain consumer constructs through its own static new", (t: Test) => {
    t.isInstanceOf(twig, Twig, ".new returns the subclass instance")
    t.isInstanceOf(twig, Leaf, "the imported consumer stays in the runtime chain")
    t.equal(twig.modelId, "t1", "the required key from the deep chain is assigned")
    t.equal(twig.midValue, 3, "the nested intermediate's key survives two hops")
    t.equal(twig.twigValue, true, "the subclass's own config key is assigned")
    t.equal(twig.label, "l", "the mixin key from the imported chain is assigned")
})

void [ t1, t2 ]
