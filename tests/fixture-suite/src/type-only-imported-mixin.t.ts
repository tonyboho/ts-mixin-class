import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import type { SourceClass1 } from "./mixins.js"

class TypeOnlyImportConsumer implements SourceClass1<string> {
}

const consumer = new TypeOnlyImportConsumer()

const v1: string = consumer.value1
const v2: string = consumer.passThrough1("typed")
const v3: string = consumer.method1()
const v4: string = TypeOnlyImportConsumer.staticMethod1()

// @ts-expect-error Type-only imported mixin keeps its type arguments.
const e1: number = consumer.passThrough1(1)

it("uses a type-only imported mixin as a runtime mixin", async (t: Test) => {
    t.equal(consumer.value1, "value1", "Type-only imported mixin field is applied")
    t.equal(consumer.passThrough1("typed"), "typed", "Type-only imported mixin generic is preserved")
    t.equal(consumer.method1(), "value1", "Type-only imported mixin method works")
    t.equal(TypeOnlyImportConsumer.staticMethod1(), "staticMethod1", "Type-only imported mixin static is applied")
})

void [ v1, v2, v3, v4, e1 ]
