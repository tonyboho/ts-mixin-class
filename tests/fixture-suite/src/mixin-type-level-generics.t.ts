import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// Type-LEVEL member shapes surviving the interface clone: template-literal, conditional and
// mapped types in a mixin's signatures (§1.36), and an F-BOUNDED (recursive) generic
// constraint on the mixin itself (`<T extends Comparable<T>>`, §6.8) — the shape planned for
// covariant containers.

type EventName<T extends string> = `on${Capitalize<T>}`
type Unwrap<T> = T extends Promise<infer U> ? U : T

@mixin()
class Events {
    eventName<T extends string>(name: T): EventName<T> {
        const capital = name.charAt(0).toUpperCase() + name.slice(1)

        return (`on${capital}`) as EventName<T>
    }

    unwrap<T>(value: T): Unwrap<T> {
        return value as Unwrap<T>
    }

    flags(): { [K in "a" | "b"]: boolean } {
        return { a: true, b: false }
    }
}

class Emitter implements Events {
}

interface Comparable<T> {
    compareTo(other: T): number
}

@mixin()
class Sorter<T extends Comparable<T>> {
    best(items: T[]): T | undefined {
        return [ ...items ].sort((a, b) => a.compareTo(b))[0]
    }
}

class Version implements Comparable<Version> {
    constructor(public num: number = 0) {}

    compareTo(other: Version): number {
        return this.num - other.num
    }
}

class VersionSorter implements Sorter<Version> {
}

it("template-literal / conditional / mapped types in mixin signatures", (t: Test) => {
    const emitter = new Emitter()

    // The template-literal return narrows per call site through the generated interface.
    const clicked: "onClick" = emitter.eventName("click")

    t.equal(clicked, "onClick", "the template-literal type computes at runtime too")

    const unwrapped: number = emitter.unwrap(42)

    t.equal(unwrapped, 42, "the conditional (infer) type resolves at the call site")

    const flag: boolean = emitter.flags().a

    t.true(flag, "the mapped-type member is usable on the consumer")
})

it("an F-bounded generic mixin (<T extends Comparable<T>>)", (t: Test) => {
    const sorter = new VersionSorter()
    const best   = sorter.best([ new Version(3), new Version(1), new Version(2) ])

    t.equal(best?.num, 1, "the recursive constraint types and sorts through the consumer")

    // NOTE: the negative case (`implements Sorter<number>` → TS2344) cannot live here: the
    // heritage type argument is cloned into generated nodes, so a same-line `@ts-expect-error`
    // suppresses only ONE of the duplicated diagnostics and the fixture build stays red
    // (see TODO.md "@ts-expect-error on an erroring mixin heritage").
})
