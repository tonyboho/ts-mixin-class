import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

@mixin()
class StaticMixin<T> {
    static staticValue: number = 10

    static staticHelper(x: number): number {
        return x * 2
    }

    value1: string = "value1"

    passThrough1(a: T): T {
        return a
    }
}

@mixin()
class PlainMixin<A> {
    value2: string = "value2"

    passThrough2(a: A): A {
        return a
    }
}

class Base {
    baseValue: number = 42

    static staticBase(): string {
        return "staticBase"
    }
}

class Consumer<A> extends Base implements StaticMixin<string>, PlainMixin<A> {
}

const t1: number = StaticMixin.staticHelper(2)
const t2: number = StaticMixin.staticValue

// @ts-expect-error staticHelper accepts number.
const e1: number = StaticMixin.staticHelper("x")

const t3: number = Consumer.staticHelper(3)
const t4: number = Consumer.staticValue
const t5: string = Consumer.staticBase()

// @ts-expect-error Missing static members are rejected.
const e2: unknown = Consumer.noSuchStatic

const c = new Consumer<boolean>()
const t6: string = c.passThrough1("x")
const t7: boolean = c.passThrough2(true)

it("statics", async (t: Test) => {
    t.equal(StaticMixin.staticHelper(2), 4, "Mixin static method works directly")
    t.equal(StaticMixin.staticValue, 10, "Mixin static field works directly")

    t.equal(Consumer.staticHelper(3), 6, "Consumer inherits mixin static method")
    t.equal(Consumer.staticValue, 10, "Consumer inherits mixin static field")
    t.equal(Consumer.staticBase(), "staticBase", "Consumer keeps base statics")

    t.equal(c.value1, "value1", "Instance part still works")
})

void [ t1, t2, t3, t4, t5, t6, t7, e1, e2 ]
