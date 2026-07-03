import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { ContractMixin, Named } from "ts-mixin-class-fixture-suite/mixins"

// §5 boundaries (relocated from the fixture-suite when program-local `.mix` became
// TS990012): STACKING two INDEPENDENT declaration mixins by nesting `.mix` calls
// (`extends A.mix(B.mix(Base))`), and the const-assigned application
// (`const K = Mixin.mix(Base); class X extends K {}`) reused by two subclasses.
// The base classes stay local — only the MIXIN must come from declarations.
class Box {
    contents: string

    constructor(contents: string) {
        this.contents = contents
    }

    static box(): string {
        return "box"
    }
}

class Crate extends Named.mix(ContractMixin.mix(Box)) {
    summary(): string {
        return `${this.contents}:${this.label()}:${this.contractMethod()}`
    }
}

const crate = new Crate("books")

const t1: string = crate.contents
const t2: string = crate.label()
const t3: string = crate.contractMethod()
const t4: string = Crate.box()
const t5: string = Crate.mixinStatic()

// @ts-expect-error the stacked mix keeps the base constructor signature.
new Crate(1)

it("manual mix stacks independent declaration mixins", async (t: Test) => {
    t.equal(crate.contents, "books", "stacked mix keeps the base constructor field")
    t.equal(crate.label(), "Ada", "the outer mixin's member is present")
    t.equal(crate.contractMethod(), "contract", "the inner mixin's member is present")
    t.equal(crate.summary(), "books:Ada:contract", "a consumer can use members from every layer")
    t.equal(Crate.box(), "box", "base statics survive the stack")
    t.equal(Crate.mixinStatic(), "mixinStatic", "the outer mixin's statics survive the stack")
    t.isInstanceOf(crate, Box, "instance matches the base")
    t.isInstanceOf(crate, Named, "instance matches the outer mixin")
    t.isInstanceOf(crate, ContractMixin, "instance matches the inner mixin")
})

class Point {
    constructor(public x: number, public y: number) {}
}

const NamedPoint = Named.mix(Point)

class Pixel extends NamedPoint {
    describe(): string {
        return `${this.label()}:${this.x},${this.y}`
    }
}

class Sprite extends NamedPoint {
    own(): string {
        return "sprite"
    }
}

it("manual .mix result assigned to a const and extended by two subclasses", async (t: Test) => {
    const pixel = new Pixel(1, 2)

    t.equal(pixel.describe(), "Ada:1,2", "the const-based application keeps the base ctor and the mixin member")
    t.isInstanceOf(pixel, Point, "instanceof matches the base through the const")
    t.isInstanceOf(pixel, Named, "instanceof matches the mixin through the const")

    const sprite = new Sprite(3, 4)

    t.equal(sprite.own(), "sprite", "a second subclass of the same const works")
    t.equal(sprite.label(), "Ada", "and carries the mixin member independently")
})

void [ t1, t2, t3, t4, t5 ]
