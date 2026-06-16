import { mixin } from "ts-mixin-class"
import { base, factory, requirements } from "ts-mixin-class/base"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

@mixin()
class SourceClass1<T> {
    value1: string = "value1"

    passThrough1(a: T): T {
        return a
    }

    method1(): string {
        return this.value1
    }

    makeAnother(): SourceClass1<number> {
        return new SourceClass1<number>()
    }
}

@mixin()
class ChildMixin<T> implements SourceClass1<T> {
    childMethod(a: T): string {
        return "child/" + String(super.passThrough1(a)) + "/" + super.method1()
    }
}

class Base {
    baseValue: number = 42
}

class Consumer<A> extends Base implements ChildMixin<A> {
}

const c = new Consumer<boolean>()
const canonicalChild = new ChildMixin<number>()

const t1: string = c.childMethod(true)
const t2: boolean = c.passThrough1(false)
const t3: string = canonicalChild.childMethod(5)

const another = c.makeAnother()
const t4: number = another.passThrough1(5)

// @ts-expect-error makeAnother returns SourceClass1<number>.
const e1: string = another.passThrough1(5)

// @ts-expect-error childMethod accepts A = boolean.
const e2: string = c.childMethod("x")

it("self-reference", async (t: Test) => {
    t.equal(c.childMethod(true), "child/true/value1", "super calls in dependent mixin body work")
    t.equal(c.baseValue, 42, "Consumer gets base field")
    t.isInstanceOf(c, ChildMixin, "Consumer matches the direct dependent mixin")
    t.isInstanceOf(c, SourceClass1, "Consumer matches the transitive consumed mixin")
    t.equal(canonicalChild.childMethod(5), "child/5/value1", "Canonical dependent mixin class can be instantiated")
    t.isInstanceOf(canonicalChild, ChildMixin, "Canonical dependent mixin instance matches the direct mixin")
    t.isInstanceOf(canonicalChild, SourceClass1, "Canonical dependent mixin instance matches the transitive mixin")
    t.equal(typeof ChildMixin[factory], "function", "Mixin factory is visible through the exported metadata symbol")
    t.expect(ChildMixin[requirements]).toEqual([ SourceClass1 ])
    t.expect(SourceClass1[requirements]).toEqual([])
    t.equal(ChildMixin[base], Object, "Dependent mixin without required base reports Object")

    const fresh = c.makeAnother()

    t.equal(fresh.value1, "value1", "Self-created instance has mixin fields")
    t.false("baseValue" in fresh, "Self-created instance does not drag consumer base")
    t.isInstanceOf(fresh, SourceClass1, "Self-created instance is an instance of the outer mixin const")
})

void [ t1, t2, t3, t4, e1, e2, another, ChildMixin ]
