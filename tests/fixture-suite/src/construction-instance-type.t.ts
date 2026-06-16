import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base, mixin } from "ts-mixin-class"


class InstanceTypeBase<T> extends Base {
    public requiredBaseValue!: string
    skippedBaseValue: string | undefined
}

@mixin()
class InstanceTypeMixin {
    public requiredMixinValue!: string
    skippedMixinValue: string | undefined

    mixinMethod(): string | undefined {
        return this.skippedMixinValue
    }
}

class InstanceTypeConsumer extends InstanceTypeBase<string> implements InstanceTypeMixin {
    public requiredOwnValue!: string
    skippedOwnValue: string | undefined
}

const constructed = InstanceTypeConsumer.new({
    mixinMethod       : () => "method",
    skippedBaseValue  : "base",
    skippedMixinValue : "mixin",
    skippedOwnValue   : "own"
})

const t1: string | undefined = constructed.skippedBaseValue
const t2: string | undefined = constructed.skippedMixinValue
const t3: string | undefined = constructed.skippedOwnValue
const t4: string | undefined = constructed.mixinMethod()

// @ts-expect-error instance-type config still rejects properties that are not on the consumer instance.
InstanceTypeConsumer.new({ missingValue : "x" })

it("constructs consumers through Base.new instance-type config objects", async (t: Test) => {
    t.isInstanceOf(constructed, InstanceTypeConsumer, "Base.new returns the instance-type consumer instance")
    t.isInstanceOf(constructed, InstanceTypeBase, "Base.new keeps the instance-type explicit base")
    t.isInstanceOf(constructed, InstanceTypeMixin, "Base.new keeps the instance-type consumed mixin instanceof")
    t.equal(constructed.skippedBaseValue, "base", "Instance-type config allows base fields without public")
    t.equal(constructed.skippedMixinValue, "mixin", "Instance-type config allows mixin fields without public")
    t.equal(constructed.skippedOwnValue, "own", "Instance-type config allows consumer fields without public")
    t.equal(constructed.mixinMethod(), "method", "Instance-type config uses the whole instance shape")
})

void [
    t1,
    t2,
    t3,
    t4
]
