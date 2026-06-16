import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { mixin } from "ts-mixin-class"
import { Base } from "ts-mixin-class/base"


class UndefinedShapeBase extends Base {
    public baseValue: number = undefined
}

class PlainUndefinedShape extends Base {
    public value: number = undefined
}

@mixin()
class UndefinedShapeMixin {
    public mixinValue: string = undefined

    mixinMethod(): string {
        return this.mixinValue
    }
}

class UndefinedShapeConsumer extends UndefinedShapeBase implements UndefinedShapeMixin {
    public ownValue: boolean = undefined
}

const unconfigured = new UndefinedShapeConsumer()
const plainUnconfigured = new PlainUndefinedShape()
const plainConfigured = PlainUndefinedShape.new({ value : 7 })
const configured = UndefinedShapeConsumer.new({
    baseValue  : 10,
    mixinValue : "configured",
    ownValue   : true
})

const t1: number = configured.baseValue
const t2: string = configured.mixinValue
const t3: boolean = configured.ownValue
const t4: string = configured.mixinMethod()
const t5: number = plainConfigured.value

// @ts-expect-error allowUndefinedForRequiredProperties does not widen required property types.
const e1: undefined = configured.baseValue

// @ts-expect-error allowUndefinedForRequiredProperties does not widen plain Base descendant property types.
const e2: undefined = plainConfigured.value

it("allows undefined initializers for required public construction properties", async (t: Test) => {
    t.true(Object.hasOwn(plainUnconfigured, "value"), "Plain Base descendant required property keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "baseValue"), "Base required property keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "mixinValue"), "Mixin required property keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "ownValue"), "Consumer required property keeps an own slot")

    t.equal(plainUnconfigured.value, undefined as unknown as number,
        "Plain Base descendant required property starts as undefined")
    t.equal(unconfigured.baseValue, undefined as unknown as number, "Base required property starts as undefined")
    t.equal(unconfigured.mixinValue, undefined as unknown as string, "Mixin required property starts as undefined")
    t.equal(unconfigured.ownValue, undefined as unknown as boolean, "Consumer required property starts as undefined")

    t.equal(plainConfigured.value, 7, "Base.new assigns the plain Base descendant required property")
    t.equal(configured.baseValue, 10, "Base.new assigns the base required property")
    t.equal(configured.mixinValue, "configured", "Base.new assigns the mixin required property")
    t.equal(configured.ownValue, true, "Base.new assigns the consumer required property")
    t.equal(configured.mixinMethod(), "configured", "Mixin methods see configured required properties")
})

void [
    t1,
    t2,
    t3,
    t4,
    t5,
    e1,
    e2
]
