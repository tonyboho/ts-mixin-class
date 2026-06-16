import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { ContractMixin } from "ts-mixin-class-fixture-suite/mixins"

// Manual application (`.mix(Base)`) of a non-generic mixin imported from another
// package through its declarations. This exercises the `mix` method type from the
// factored MixinClassValue alias across the package boundary -- the inference
// path most sensitive to the alias being structurally identical to the old inline
// cast.
class ManualBase {
    baseField: string = "base"

    baseMethod(): string {
        return this.baseField
    }
}

class ManualMixed extends ContractMixin.mix(ManualBase) {
    combined(): string {
        return `${this.contractMethod()}/${this.baseMethod()}`
    }
}

const mixed = new ManualMixed()

const contractValue: string = mixed.contractValue
const contractResult: string = mixed.contractMethod()
const baseValue: string = mixed.baseField
const baseResult: string = mixed.baseMethod()
const combinedResult: string = mixed.combined()

// @ts-expect-error The mixed instance keeps contractValue as string.
const wrong: number = mixed.contractValue

it("manually applies a non-generic declaration mixin through .mix()", async (t: Test) => {
    t.equal(contractValue, "contract", "Declaration mixin field is applied through manual .mix()")
    t.equal(contractResult, "contract", "Declaration mixin method works through manual .mix()")
    t.equal(baseValue, "base", "Manual base field is preserved")
    t.equal(baseResult, "base", "Manual base method is preserved")
    t.equal(combinedResult, "contract/base", "Mixin and manual base combine through super-less composition")
    t.true(mixed instanceof ManualBase, "Manual base stays in the prototype chain")
    t.true(mixed instanceof ContractMixin, "Manually applied mixin is recognized via instanceof")

    void wrong
})
