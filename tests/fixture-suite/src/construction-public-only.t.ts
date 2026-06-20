import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { mixin } from "ts-mixin-class"
import { Base } from "ts-mixin-class/base"


class Model extends Base {
    public id: string = ""
    public name?: string = ""
}

// @ts-expect-error no config
const model1 = Model.new()

// @ts-expect-error missing required config
const model2 = Model.new({ name: "John Doe" })

class Model2 extends Base {
    public name?: string = ""
}

const model21 = Model2.new()
const model22 = Model2.new({})

void [ model21, model22 ]


class ConstructableBase extends Base {
    public baseValue: string = "base"
    public optionalBaseValue?: string
    skippedBaseValue: string = "skipped"
}

@mixin()
class ConstructableMixin {
    public mixinValue: number = 0
    public optionalMixinValue?: number
    skippedMixinValue: number = -1

    mixinMethod(): number {
        return this.mixinValue
    }
}

class ConstructableConsumer extends ConstructableBase implements ConstructableMixin {
    public ownValue: boolean = false
    public optionalOwnValue?: boolean
    public definiteOwnValue!: string
    skippedOwnValue: boolean = false
    initializedLabel: string = ""

    override initialize(config?: ConstructableConsumerConfig): void {
        super.initialize(config)

        this.initializedLabel = `${this.baseValue}/${this.mixinValue}/${this.ownValue}`
    }
}

const constructed = ConstructableConsumer.new({
    baseValue           : "configured",
    definiteOwnValue    : "definite",
    mixinValue          : 42,
    optionalBaseValue   : "optional-base",
    optionalMixinValue  : 43,
    optionalOwnValue    : true,
    ownValue            : true
})

const t1: string = constructed.baseValue
const t2: number = constructed.mixinValue
const t3: boolean = constructed.ownValue
const t4: number = constructed.mixinMethod()
const t5: string = constructed.initializedLabel
const t6: string = constructed.definiteOwnValue
const t7: string | undefined = constructed.optionalBaseValue
const t8: number | undefined = constructed.optionalMixinValue
const t9: boolean | undefined = constructed.optionalOwnValue

// @ts-expect-error Base.new config excludes methods.
ConstructableConsumer.new({ mixinMethod : () => 1 })

// @ts-expect-error Base.new config rejects unknown properties.
ConstructableConsumer.new({ missingValue : "nope" })

// @ts-expect-error public-only construction config excludes fields without an explicit public modifier.
ConstructableConsumer.new({ skippedOwnValue : true })

// @ts-expect-error public-only construction config requires public fields without a question mark.
ConstructableConsumer.new({
    baseValue  : "configured",
    mixinValue : 42,
    ownValue   : true
})

ConstructableConsumer.new({
    baseValue        : "configured",
    definiteOwnValue : "definite",
    mixinValue       : 42,
    ownValue         : true
})

it("constructs consumers through Base.new public-only config objects", async (t: Test) => {
    t.isInstanceOf(constructed, ConstructableConsumer, "Base.new returns the consumer instance")
    t.isInstanceOf(constructed, ConstructableBase, "Base.new keeps the explicit base")
    t.isInstanceOf(constructed, ConstructableMixin, "Base.new keeps consumed mixin instanceof")
    t.equal(constructed.baseValue, "configured", "Base config property is assigned")
    t.equal(constructed.mixinValue, 42, "Mixin config property is assigned")
    t.equal(constructed.ownValue, true, "Consumer config property is assigned")
    t.equal(constructed.definiteOwnValue, "definite", "Definite assignment config property is assigned")
    t.equal(constructed.optionalBaseValue, "optional-base", "Optional base config property is assigned when present")
    t.equal(constructed.optionalMixinValue, 43, "Optional mixin config property is assigned when present")
    t.equal(constructed.optionalOwnValue, true, "Optional consumer config property is assigned when present")
    t.equal(constructed.initializedLabel, "configured/42/true", "Custom initialize runs after config assignment")
    t.equal(constructed.mixinMethod(), 42, "Mixin methods work after Base.new initialization")
})

void [
    t1,
    t2,
    t3,
    t4,
    t5,
    t6,
    t7,
    t8,
    t9
]
