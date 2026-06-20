import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §5 boundary: STACKING two INDEPENDENT mixins by nesting `.mix` calls
// (`extends A.mix(B.mix(Base))`), as opposed to the single `Mixin.mix(Base)` the existing
// manual-mix fixtures cover, and as opposed to a mixin that DEPENDS on another (§5.4).
// Here `Tagged` and `Counted` know nothing of each other; composing them by hand must
// layer both onto the base — both mixins' members and statics, the base constructor, and
// `instanceof` for every layer.
class Box {
    contents: string

    constructor(contents: string) {
        this.contents = contents
    }

    static box(): string {
        return "box"
    }
}

@mixin()
class Tagged {
    static tag(): string {
        return "tag"
    }

    tags: string[] = []

    addTag(tag: string): void {
        this.tags.push(tag)
    }
}

@mixin()
class Counted {
    count: number = 0

    bump(): void {
        this.count = this.count + 1
    }
}

class Crate extends Tagged.mix(Counted.mix(Box)) {
    summary(): string {
        return `${this.contents}:${this.tags.length}:${this.count}`
    }
}

const crate = new Crate("books")

crate.addTag("a")
crate.bump()
crate.bump()

const t1: string = crate.contents
const t2: number = crate.count
const t3: string[] = crate.tags
const t4: string = Crate.box()
const t5: string = Crate.tag()

// @ts-expect-error the stacked mix keeps the base constructor signature.
new Crate(1)

it("manual mix stacked independent mixins", async (t: Test) => {
    t.equal(crate.contents, "books", "stacked mix keeps the base constructor field")
    t.equal(crate.tags.length, 1, "the outer mixin's member is present")
    t.equal(crate.count, 2, "the inner mixin's member is present")
    t.equal(crate.summary(), "books:1:2", "a consumer can use members from every layer")
    t.equal(Crate.box(), "box", "base statics survive the stack")
    t.equal(Crate.tag(), "tag", "the outer mixin's statics survive the stack")
    t.isInstanceOf(crate, Box, "instance matches the base")
    t.isInstanceOf(crate, Tagged, "instance matches the outer mixin")
    t.isInstanceOf(crate, Counted, "instance matches the inner mixin")
})

void [ t1, t2, t3, t4, t5 ]
