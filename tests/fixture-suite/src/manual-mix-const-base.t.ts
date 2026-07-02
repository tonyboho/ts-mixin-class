import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §5 boundary: the documented WORKAROUND for a dynamic consumer base (§11.4 suggests "assign the
// expression to a named class or const"): `const K = Mixin.mix(Base); class X extends K {}`.
// The const-assigned application must behave exactly like the inline `extends Mixin.mix(Base)`
// form — base constructor kept, mixin members present, `instanceof` matching both layers — and
// the const value must be reusable by TWO subclasses without shared-state surprises.
@mixin()
class Tagged {
    tag(value: string): string {
        return `[${value}]`
    }
}

class Point {
    constructor(public x: number, public y: number) {}
}

const TaggedPoint = Tagged.mix(Point)

class Pixel extends TaggedPoint {
    describe(): string {
        return this.tag(`${this.x},${this.y}`)
    }
}

class Sprite extends TaggedPoint {
    own(): string {
        return "sprite"
    }
}

it("manual .mix result assigned to a const and extended", async (t: Test) => {
    const pixel = new Pixel(1, 2)

    t.equal(pixel.describe(), "[1,2]", "the const-based application keeps the base ctor and the mixin member")
    t.isInstanceOf(pixel, Point, "instanceof matches the base through the const")
    t.isInstanceOf(pixel, Tagged, "instanceof matches the mixin through the const")

    const sprite = new Sprite(3, 4)

    t.equal(sprite.own(), "sprite", "a second subclass of the same const works")
    t.equal(sprite.tag("s"), "[s]", "and carries the mixin member independently")
})
