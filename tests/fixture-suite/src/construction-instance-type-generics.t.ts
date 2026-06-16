import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base, mixin } from "ts-mixin-class"


class InstanceTypeGenericBase<T> extends Base {
    public requiredBaseValue!: T
    skippedBaseValue: T | undefined
}

@mixin()
class InstanceTypeGenericMixin<T> {
    public requiredMixinValue!: T
    skippedMixinValue: T | undefined

    mixinMethod(): T | undefined {
        return this.skippedMixinValue
    }
}

class InstanceTypeGenericConsumer<T> extends InstanceTypeGenericBase<T> implements InstanceTypeGenericMixin<T> {
    public requiredOwnValue!: T
    skippedOwnValue: T | undefined
}

const inferred = InstanceTypeGenericConsumer.new({
    skippedBaseValue  : "base",
    skippedMixinValue : "mixin",
    skippedOwnValue   : "own"
})

const t1: string | undefined = inferred.skippedBaseValue
const t2: string | undefined = inferred.skippedMixinValue
const t3: string | undefined = inferred.skippedOwnValue
const t4: string | undefined = inferred.mixinMethod()

// @ts-expect-error instance-type config infers T = string.
const e1: number | undefined = inferred.skippedMixinValue

const explicit = InstanceTypeGenericConsumer.new<number>({
    skippedBaseValue  : 1,
    skippedMixinValue : 2,
    skippedOwnValue   : 3
})

const t5: number | undefined = explicit.skippedOwnValue

// @ts-expect-error Explicit InstanceTypeGenericConsumer.new<number> rejects string config values.
InstanceTypeGenericConsumer.new<number>({ skippedOwnValue : "own" })

it("constructs generic consumers through Base.new instance-type config objects", async (t: Test) => {
    t.isInstanceOf(inferred, InstanceTypeGenericConsumer, "Generated static new returns a generic instance-type consumer")
    t.isInstanceOf(inferred, InstanceTypeGenericMixin, "Generic instance-type consumer keeps consumed mixin instanceof")
    t.equal(inferred.skippedBaseValue, "base", "Generic instance-type base config property is assigned")
    t.equal(inferred.skippedMixinValue, "mixin", "Generic instance-type mixin config property is assigned")
    t.equal(inferred.skippedOwnValue, "own", "Generic instance-type consumer config property is assigned")
    t.equal(inferred.mixinMethod(), "mixin", "Generic instance-type mixin method keeps inferred T")
    t.equal(explicit.skippedOwnValue, 3, "Explicit generic instance-type config property is assigned")
})

void [
    t1,
    t2,
    t3,
    t4,
    t5,
    e1
]
