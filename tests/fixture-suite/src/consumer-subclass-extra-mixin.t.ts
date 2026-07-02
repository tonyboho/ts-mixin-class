import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §2 boundary: a SUBCLASS OF A CONSUMER that adds MORE mixins
// (`class Sub extends Consumer implements Extra`) — the everyday layering pattern, distinct
// from the plain subclass of §2.3. The subclass must carry both mixin sets, thread `super`
// through the whole chain, and match `instanceof` for every layer.
@mixin()
class Walks {
    moves: string[] = []

    walk(): string {
        this.moves.push("walk")
        return "walking"
    }

    describe(): string {
        return "walker"
    }
}

@mixin()
class Swims {
    swim(): string {
        return "swimming"
    }

    describe(): string {
        return "swimmer"
    }
}

class Animal implements Walks {
}

class Amphibian extends Animal implements Swims {
    describe(): string {
        return "amphibian(" + super.describe() + ")"
    }
}

const amphibian = new Amphibian()

// Compile-time half: both mixin sets exist on the subclass type.
const walked: string  = amphibian.walk()
const swam: string    = amphibian.swim()

void [ walked, swam ]

it("a subclass of a consumer adds more mixins on top", async (t: Test) => {
    t.equal(amphibian.walk(), "walking", "the base consumer's mixin member works on the subclass")
    t.equal(amphibian.swim(), "swimming", "the subclass's own mixin member works")
    t.equal(amphibian.moves.length, 2, "mixin state accumulates on the one instance")

    // Swims is applied on the subclass layer, above Animal's chain — so super.describe()
    // reaches Swims first (the nearest chain layer above Amphibian).
    t.equal(amphibian.describe(), "amphibian(swimmer)", "super threads into the subclass's own mixin layer")

    t.true(amphibian instanceof Animal, "instanceof matches the consumer base")
    t.true(amphibian instanceof Walks, "instanceof matches the base consumer's mixin")
    t.true(amphibian instanceof Swims, "instanceof matches the subclass's mixin")

    const animal = new Animal()

    t.false(animal instanceof Swims, "the base consumer does NOT match the subclass's mixin")
    t.equal(animal.describe(), "walker", "the base consumer keeps its own chain")
})
