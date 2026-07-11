import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Base } from "ts-mixin-class"
import { ConstructionScaled } from "ts-mixin-class-fixture-suite/mixins"

// §5.9 / §9.2, pinned on the only legal side of manual `.mix`: an EXTERNAL declaration
// mixin. Config tracking deliberately stops at the application expression. The class keeps
// only the factual Base-descendant's inherited `.new`, config and RETURN type; neither the
// declaration mixin's field nor the subclass's own field becomes a config key.
class ManualConstructionBase extends Base {
    public baseKey!: string
}

class ManualConstruction extends ConstructionScaled.mix(ManualConstructionBase) {
    public ownKey!: boolean
}

const built = ManualConstruction.new({ baseKey: "base" })

const baseResult: ManualConstructionBase = built

function typeOnlyChecks(): void {
    // @ts-expect-error config tracking stops before the declaration mixin's field
    ManualConstruction.new({ baseKey: "base", height: 20 })

    // @ts-expect-error config tracking also excludes the subclass's own field
    ManualConstruction.new({ baseKey: "base", ownKey: true })

    // @ts-expect-error inherited .new intentionally returns the factual construction base
    const subclassResult: ManualConstruction = built

    void subclassResult
}

it("manual declaration .mix keeps only the factual base construction contract", async (t: Test) => {
    t.isInstanceOf(built, ManualConstructionBase, "the inherited factory constructs the factual base")
    t.isInstanceOf(built, ManualConstruction, "runtime new-this still constructs the manual subclass")
    t.is(built.baseKey, "base", "the base config is applied")
})

void [ baseResult, typeOnlyChecks ]
