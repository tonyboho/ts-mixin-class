import { mixin } from "ts-mixin-class"

// --- Two independent mixins -------------------------------------------------

@mixin()
class Named {
    name: string = "Ada"

    label(): string {
        return this.name
    }
}

@mixin()
class Timestamped {
    createdAt: Date = new Date()

    age(): number {
        return Date.now() - this.createdAt.getTime()
    }
}

// A consumer composes both mixins with native `implements`.
// `super` reaches into the mixin chain.
class User implements Named, Timestamped {
    describe(): string {
        return `${super.label()} (age ${super.age()}ms)`
    }
}

const user = new User()

console.log("label:                ", user.label())
console.log("describe:             ", user.describe())
console.log("instanceof Named:     ", user instanceof Named)
console.log("instanceof Timestamped:", user instanceof Timestamped)

// --- C3 linearization (diamond) ---------------------------------------------

@mixin()
class Root {
    print(): string {
        return "Root"
    }
}

@mixin()
class Left implements Root {
    print(): string {
        return `Left > ${super.print()}`
    }
}

@mixin()
class Right implements Root {
    print(): string {
        return `Right > ${super.print()}`
    }
}

class Combined implements Left, Right {
    print(): string {
        return `Combined > ${super.print()}`
    }
}

console.log()
console.log("C3 order:             ", new Combined().print())
// Combined > Left > Right > Root

// --- Generics ---------------------------------------------------------------

@mixin()
class StoredValue<T> {
    value: T | undefined

    getValue(): T | undefined {
        return this.value
    }
}

class Box<T> implements StoredValue<T> {
    constructor(value: T) {
        this.value = value
    }
}

const box = new Box<number>(42)
const value: number | undefined = box.getValue()

console.log()
console.log("generic getValue():   ", value)
