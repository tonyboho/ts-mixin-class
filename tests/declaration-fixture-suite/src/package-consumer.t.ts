import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { RequiredBase, RequiredMixin, SourceClass1, SourceClass2 } from "ts-mixin-class-fixture-suite/mixins"

class GenericBase<T> {
    baseValue: T

    constructor(baseValue: T) {
        this.baseValue = baseValue
    }

    baseMethod(): T {
        return this.baseValue
    }
}

class Consumer1 extends GenericBase<number> implements SourceClass1<string>, SourceClass2<boolean> {
    own(): number {
        return super.baseMethod()
    }
}

class Consumer2 extends GenericBase<number> implements SourceClass1<string> {
}

class DeclarationRequiredBase extends RequiredBase {
    override requiredMethod(): string {
        return "declaration/" + super.requiredMethod()
    }
}

class DeclarationRequiredConsumer extends DeclarationRequiredBase implements RequiredMixin {
    ownRequired(): string {
        return super.requiredMixinMethod()
    }
}

const consumer = new Consumer1(42)
const required = new DeclarationRequiredConsumer()

const v1: number = consumer.baseValue
const v2: number = consumer.own()
const v3: string = consumer.passThrough1("typed")
const v4: boolean = consumer.passThrough2(true)
const v5: string = required.requiredMixinMethod()
const v6: string = required.ownRequired()

// @ts-expect-error Declaration consumer keeps GenericBase<number>.
const e1: string = consumer.baseValue

// @ts-expect-error Declaration consumer keeps SourceClass1<string>.
const e2: string = consumer.passThrough1(1)

// @ts-expect-error Declaration consumer keeps SourceClass2<boolean>.
const e3: string = consumer.passThrough2("x")

it("uses mixins from another package through declarations", async (t: Test) => {
    const second = new Consumer2(7)

    t.equal(consumer.baseValue, 42, "Generic base field is typed and initialized")
    t.equal(consumer.own(), 42, "Generic base super method works")
    t.equal(consumer.method1(), "value1", "First declaration mixin method works")
    t.equal(consumer.method2(), "value2", "Second declaration mixin method works")
    t.equal(consumer.passThrough1("typed"), "typed", "First declaration mixin generic is preserved")
    t.equal(consumer.passThrough2(true), true, "Second declaration mixin generic is preserved")
    t.equal(second.passThrough1("again"), "again", "Second package consumer reuses imported declaration mixin")
    t.equal(required.requiredMixinMethod(), "declaration/requiredBase/requiredMixin", "Declaration required-base mixin uses the consumer base")
    t.equal(required.ownRequired(), "declaration/requiredBase/requiredMixin", "Declaration required-base mixin is available through super")
    t.equal(DeclarationRequiredConsumer.staticRequired(), "staticRequired", "Declaration required-base consumer keeps base statics")
    t.equal(DeclarationRequiredConsumer.staticRequiredMixin(), "staticRequiredMixin", "Declaration required-base consumer keeps mixin statics")
    t.isInstanceOf(consumer, SourceClass1, "Declaration-imported first mixin instanceof works")
    t.isInstanceOf(consumer, SourceClass2, "Declaration-imported second mixin instanceof works")
    t.isInstanceOf(required, RequiredMixin, "Declaration required-base consumer matches the mixin")
    t.isInstanceOf(required, RequiredBase, "Declaration required-base consumer keeps the required base")
})

void [ v1, v2, v3, v4, v5, v6, e1, e2, e3 ]
