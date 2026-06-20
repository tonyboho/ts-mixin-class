import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §6 boundary: a mixin METHOD with its OWN type parameter (`mapItems<U>(...)`), distinct from
// a class-level generic (§6.4). The method-level type parameter must survive into the
// consumer's generated interface member and be inferred independently per call site.
@mixin()
class Container<T> {
    items: T[] = []

    add(item: T): void {
        this.items.push(item)
    }

    mapItems<U>(project: (item: T) => U): U[] {
        return this.items.map(project)
    }
}

class NumberBox implements Container<number> {
}

const box = new NumberBox()
box.add(2)
box.add(3)

// `U` is inferred at the call site: number -> string here, number -> number there.
const labels: string[]  = box.mapItems((n) => `#${n}`)
const doubled: number[] = box.mapItems((n) => n * 2)

it("mixin generic method", async (t: Test) => {
    t.isDeeply(labels, [ "#2", "#3" ], "the method-level type parameter infers string at one call site")
    t.isDeeply(doubled, [ 4, 6 ], "the same method infers number at a different call site")
})

void [ labels, doubled ]
