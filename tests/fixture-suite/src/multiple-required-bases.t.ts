import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import {
    DeclarationNeedsRoot,
    DeclarationNeedsSpecific,
    isDeclarationSpecificBase,
    RequiredBase
} from "./mixins.js"

// §4.9 — multiple required bases composed in ONE consumer: the compiler selects the
// most-specific constraint (DeclarationSpecificBase, PRIVATE to mixins.ts) and the
// runtime replays the plan without importing it. Living in the fixture corpus, this
// file also feeds the stress sweep (navigation / quickinfo / rename over the base-plan
// and `$empty extends __Empty__` emit shapes).

class MultipleBaseConsumer implements DeclarationNeedsRoot, DeclarationNeedsSpecific {
}

it("composes mixins with multiple compatible required bases", async (t: Test) => {
    const value = new MultipleBaseConsumer()

    t.ok(isDeclarationSpecificBase(value), "the private most-specific base was selected through the plan")
    t.isInstanceOf(value, RequiredBase, "the base ancestry is preserved")
    t.isInstanceOf(value, DeclarationNeedsRoot, "the broad-base mixin is applied")
    t.isInstanceOf(value, DeclarationNeedsSpecific, "the specific-base mixin is applied")
    t.equal(value.rootMixinMethod(), "requiredBase", "the broad-base mixin sees the selected base")
    t.equal(value.specificMixinMethod(), "specificBase", "the specific-base mixin sees the selected base")
})
