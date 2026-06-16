import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { mixin } from "ts-mixin-class"

@mixin()
class StoredValue<T> {
    value: T | undefined

    getValue(): T | undefined {
        return this.value
    }
}

@mixin()
class ValueLabel<T> implements StoredValue<T> {
    label(): string {
        return String(super.getValue())
    }
}

class Box<T> implements ValueLabel<T>, StoredValue<T> {
    ownValue: T

    constructor(value: T) {
        this.ownValue = value
        this.value = value
    }

    describe(): string {
        return `${super.label()}/${String(this.ownValue)}`
    }
}

const box = new Box<number>(42)

const value: number | undefined = box.getValue()
const label: string = box.label()
const ownValue: number = box.ownValue
const description: string = box.describe()

it("runs consumer constructors without an explicit base", async (t: Test) => {
    t.equal(value, 42, "Constructor can assign a mixin field after the synthetic super call")
    t.equal(label, "42", "Mixin method sees constructor-assigned state")
    t.equal(ownValue, 42, "Constructor can assign own fields")
    t.equal(description, "42/42", "Consumer methods can call mixin super methods")
    t.isInstanceOf(box, StoredValue, "Constructed consumer matches a dependency mixin")
    t.isInstanceOf(box, ValueLabel, "Constructed consumer matches the direct mixin")
})

void [ value, label, ownValue, description ]
