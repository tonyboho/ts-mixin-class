import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base, mixin } from "ts-mixin-class"


class GenericBase<T> extends Base {
    public genericBaseValue!: T | undefined
    skippedGenericBaseValue: T | undefined
}

@mixin()
class GenericMixin<T> {
    public genericMixinValue!: T | undefined
    skippedGenericMixinValue: T | undefined

    genericMixinMethod(): T | undefined {
        return this.genericMixinValue
    }
}

class GenericConsumer<T> extends GenericBase<T> implements GenericMixin<T> {
    public genericOwnValue!: T | undefined
    skippedGenericOwnValue: T | undefined
}

@mixin()
class GenericContainerMixin {
    public touched!: boolean = false
}

class GenericContainer<T> extends Base implements GenericContainerMixin {
    public item!: T | undefined
}

const genericConstructed = GenericConsumer.new({
    genericBaseValue  : "base",
    genericMixinValue : "mixin",
    genericOwnValue   : "own"
})

const t1: string | undefined = genericConstructed.genericBaseValue
const t2: string | undefined = genericConstructed.genericMixinValue
const t3: string | undefined = genericConstructed.genericOwnValue

// @ts-expect-error Generic config infers T = string.
const e1: number | undefined = genericConstructed.genericMixinValue

// @ts-expect-error Generated static config excludes methods.
GenericConsumer.new({ genericMixinMethod : () => "x" })

// @ts-expect-error public-only construction config excludes generic fields without an explicit public modifier.
GenericConsumer.new({ skippedGenericMixinValue : "x" })

const stringContainer = GenericContainer.new({
    item    : "value",
    touched : true
})

const t4: string | undefined = stringContainer.item
const t5: boolean = stringContainer.touched

// @ts-expect-error GenericContainer.new infers T = string from the item config property.
const e2: number | undefined = stringContainer.item

const numberContainer = GenericContainer.new<number>({
    item    : 1,
    touched : false
})

const t6: number | undefined = numberContainer.item

// @ts-expect-error Explicit GenericContainer.new<number> rejects string item config.
GenericContainer.new<number>({ item : "value" })

const inferredNumberContainer = GenericContainer.new({
    item    : 2,
    touched : true
})

const t7: number | undefined = inferredNumberContainer.item

// @ts-expect-error GenericContainer.new infers T = number from the item config property.
const e3: string | undefined = inferredNumberContainer.item

it("constructs generic consumers through Base.new public-only config objects", async (t: Test) => {
    t.isInstanceOf(genericConstructed, GenericConsumer, "Generated static new returns a generic consumer")
    t.equal(genericConstructed.genericBaseValue, "base", "Generic base config property is assigned")
    t.equal(genericConstructed.genericMixinValue, "mixin", "Generic mixin config property is assigned")
    t.equal(genericConstructed.genericOwnValue, "own", "Generic consumer config property is assigned")

    t.isInstanceOf(stringContainer, GenericContainer, "Generated static new returns a generic container")
    t.isInstanceOf(stringContainer, GenericContainerMixin, "Generic container keeps consumed mixin instanceof")
    t.equal(stringContainer.item, "value", "Generic property is initialized through .new config")
    t.equal(stringContainer.touched, true, "Generic container mixin property is initialized through .new config")
    t.equal(numberContainer.item, 1, "Explicit generic .new type argument initializes a numeric property")
    t.equal(inferredNumberContainer.item, 2, "Generic .new type argument is inferred from numeric config")
})

void [
    t1,
    t2,
    t3,
    t4,
    t5,
    t6,
    t7,
    e1,
    e2,
    e3
]
