import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1 boundary: ASYNC, GENERATOR and ASYNC-GENERATOR mixin methods. The transformer copies each
// member into the consumer's structural interface with its modifiers intact, so the consumer's
// call sites keep the `Promise` / `Generator` / `AsyncGenerator` result types, `await` and
// `yield*` work through them, and an override can chain through `super`.
@mixin()
class Streams {
    async load(value: string): Promise<string> {
        return `loaded:${value}`
    }

    *numbers(limit: number): Generator<number> {
        for (let index = 0; index < limit; index++) {
            yield index
        }
    }

    async *stream(limit: number): AsyncGenerator<number> {
        for (let index = 0; index < limit; index++) {
            yield index
        }
    }
}

class Consumer implements Streams {
    // an override chaining through `super` keeps the async modifier
    async load(value: string): Promise<string> {
        return `wrapped:${await super.load(value)}`
    }

    // a plain member delegating to the injected generator
    firstTwo(): number[] {
        return [ ...this.numbers(2) ]
    }
}

it("async / generator / async-generator mixin methods", async (t: Test) => {
    const consumer = new Consumer()

    t.equal(await consumer.load("x"), "wrapped:loaded:x", "async override chains through super into the mixin body")
    t.eq(consumer.firstTwo(), [ 0, 1 ], "the injected generator method iterates on the consumer")

    const collected: number[] = []

    for await (const value of consumer.stream(3)) {
        collected.push(value)
    }

    t.eq(collected, [ 0, 1, 2 ], "the injected async generator streams on the consumer")

    // A standalone mixin instance keeps all three members.
    const canonical = new Streams()

    t.equal(await canonical.load("y"), "loaded:y", "standalone async method")
    t.eq([ ...canonical.numbers(2) ], [ 0, 1 ], "standalone generator method")
})
