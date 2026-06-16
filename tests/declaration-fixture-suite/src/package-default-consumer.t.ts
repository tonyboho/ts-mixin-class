import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import DefaultMixin from "ts-mixin-class-fixture-suite/default-mixin"

class DefaultDeclarationConsumer implements DefaultMixin {
    ownDefault(): string {
        return super.defaultMethod()
    }
}

const consumer = new DefaultDeclarationConsumer()

const v1: string = consumer.defaultValue
const v2: string = consumer.defaultMethod()
const v3: string = consumer.ownDefault()
const v4: string = DefaultDeclarationConsumer.staticDefault()

// @ts-expect-error Declaration default mixin keeps defaultValue as string.
const e1: number = consumer.defaultValue

it("uses a default-exported mixin from another package through declarations", async (t: Test) => {
    t.equal(consumer.defaultValue, "default", "Declaration default mixin field is applied")
    t.equal(consumer.defaultMethod(), "default", "Declaration default mixin method works")
    t.equal(consumer.ownDefault(), "default", "Declaration default mixin is available through super")
    t.equal(DefaultDeclarationConsumer.staticDefault(), "staticDefault", "Declaration default mixin statics are copied")
    t.isInstanceOf(consumer, DefaultMixin, "Declaration default mixin instanceof works")
})

void [ v1, v2, v3, v4, e1 ]
