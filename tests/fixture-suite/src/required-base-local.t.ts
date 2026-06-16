import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { mixin } from "ts-mixin-class"
import { base, factory, requirements } from "ts-mixin-class/base"

class RequiredBase<T> {
    requiredValue: T

    constructor(requiredValue: T) {
        this.requiredValue = requiredValue
    }

    requiredMethod(): T {
        return this.requiredValue
    }

    static staticRequired(): string {
        return "staticRequired"
    }
}

class RealBase extends RequiredBase<string> {
    override requiredMethod(): string {
        return "real/" + super.requiredMethod()
    }
}

@mixin()
class RequiredMixin extends RequiredBase<string> {
    mixinValue: string = "mixin"

    mixinMethod(): string {
        return super.requiredMethod() + "/" + this.mixinValue
    }

    static staticMixin(): string {
        return "staticMixin"
    }
}

class Consumer extends RealBase implements RequiredMixin {
    own(): string {
        return super.mixinMethod()
    }
}

class DefaultConsumer implements RequiredMixin {
}

const consumer = new Consumer("base")
const defaultConsumer = new DefaultConsumer("default")
const canonicalRequired = new RequiredMixin("canonical")

const v1: string = consumer.requiredMethod()
const v2: string = consumer.mixinMethod()
const v3: string = consumer.own()
const v4: string = Consumer.staticRequired()
const v5: string = Consumer.staticMixin()
const v6: string = defaultConsumer.requiredMethod()
const v7: string = defaultConsumer.mixinMethod()
const v8: string = canonicalRequired.mixinMethod()

// @ts-expect-error required base generic is fixed as string.
const e1: number = consumer.requiredValue

it("uses a local required-base mixin", async (t: Test) => {
    t.equal(consumer.requiredMethod(), "real/base", "Consumer uses the concrete descendant base")
    t.equal(consumer.mixinMethod(), "real/base/mixin", "Mixin super reaches the concrete base")
    t.equal(consumer.own(), "real/base/mixin", "Consumer super reaches the required-base mixin")
    t.equal(Consumer.staticRequired(), "staticRequired", "Consumer keeps required base statics")
    t.equal(Consumer.staticMixin(), "staticMixin", "Consumer keeps mixin statics")
    t.equal(defaultConsumer.requiredMethod(), "default", "No-base consumer starts from the required base")
    t.equal(defaultConsumer.mixinMethod(), "default/mixin", "No-base consumer applies the mixin over the required base")
    t.equal(canonicalRequired.requiredMethod(), "canonical", "Canonical required-base mixin receives required base constructor args")
    t.equal(canonicalRequired.mixinMethod(), "canonical/mixin", "Canonical required-base mixin methods work")
    t.isInstanceOf(canonicalRequired, RequiredMixin, "Canonical required-base mixin matches itself")
    t.isInstanceOf(canonicalRequired, RequiredBase, "Canonical required-base mixin inherits from the required base")
    t.equal(typeof RequiredMixin[factory], "function", "Required-base mixin factory is visible through the exported metadata symbol")
    t.expect(RequiredMixin[requirements]).toEqual([])
    t.equal(RequiredMixin[base], RequiredBase, "Required-base mixin reports its required base through the exported metadata symbol")
    t.isInstanceOf(consumer, RequiredMixin, "Consumer matches the required-base mixin")
    t.isInstanceOf(consumer, RealBase, "Consumer remains an instance of the concrete base")
    t.isInstanceOf(defaultConsumer, RequiredMixin, "No-base consumer matches the required-base mixin")
    t.isInstanceOf(defaultConsumer, RequiredBase, "No-base consumer inherits from the required base")
})

void [ v1, v2, v3, v4, v5, v6, v7, v8, e1 ]
