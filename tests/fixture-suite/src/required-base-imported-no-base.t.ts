import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { RequiredMixin } from "./mixins.js"

class NoBaseImportedRequiredConsumer implements RequiredMixin {
    ownRequired(): string {
        return super.requiredMixinMethod()
    }
}

const consumer = new NoBaseImportedRequiredConsumer()

const v1: string = consumer.requiredMethod()
const v2: string = consumer.requiredMixinMethod()
const v3: string = consumer.ownRequired()
const v4: string = NoBaseImportedRequiredConsumer.staticRequired()
const v5: string = NoBaseImportedRequiredConsumer.staticRequiredMixin()

it("no-base imported required-base mixin", async (t: Test) => {
    t.equal(consumer.requiredMethod(), "requiredBase", "No-base imported consumer starts from the required base")
    t.equal(consumer.requiredMixinMethod(), "requiredBase/requiredMixin", "No-base imported consumer applies the mixin")
    t.equal(consumer.ownRequired(), "requiredBase/requiredMixin", "No-base imported consumer can call mixin through super")
    t.equal(NoBaseImportedRequiredConsumer.staticRequired(), "staticRequired", "No-base imported consumer keeps required base statics")
    t.equal(NoBaseImportedRequiredConsumer.staticRequiredMixin(), "staticRequiredMixin", "No-base imported consumer keeps mixin statics")
    t.isInstanceOf(consumer, RequiredMixin, "No-base imported consumer matches the mixin")
})

void [ v1, v2, v3, v4, v5 ]
