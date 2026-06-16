import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { RequiredMixin } from "ts-mixin-class-fixture-suite/mixins"

class DeclarationNoBaseRequiredConsumer implements RequiredMixin {
    ownRequired(): string {
        return super.requiredMixinMethod()
    }
}

const consumer = new DeclarationNoBaseRequiredConsumer()

const v1: string = consumer.requiredMethod()
const v2: string = consumer.requiredMixinMethod()
const v3: string = consumer.ownRequired()
const v4: string = DeclarationNoBaseRequiredConsumer.staticRequired()
const v5: string = DeclarationNoBaseRequiredConsumer.staticRequiredMixin()

it("uses a declaration required-base mixin without an explicit consumer base", async (t: Test) => {
    t.equal(consumer.requiredMethod(), "requiredBase", "Declaration no-base consumer starts from the required base")
    t.equal(consumer.requiredMixinMethod(), "requiredBase/requiredMixin", "Declaration no-base consumer applies the mixin")
    t.equal(consumer.ownRequired(), "requiredBase/requiredMixin", "Declaration no-base consumer can call mixin through super")
    t.equal(DeclarationNoBaseRequiredConsumer.staticRequired(), "staticRequired", "Declaration no-base consumer keeps required base statics")
    t.equal(DeclarationNoBaseRequiredConsumer.staticRequiredMixin(), "staticRequiredMixin", "Declaration no-base consumer keeps mixin statics")
    t.isInstanceOf(consumer, RequiredMixin, "Declaration no-base consumer matches the mixin")
})

void [ v1, v2, v3, v4, v5 ]
