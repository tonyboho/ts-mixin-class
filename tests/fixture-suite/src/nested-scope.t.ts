import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { mixin } from "ts-mixin-class"

// Mixins and consumers declared below the top level (inside a function body or a plain block)
// expand like top-level ones. They cannot be exported (they are locals), which is all they give
// up. This fixture is part of the stress corpus, so the cases below are also swept on the
// source-view plane (quickinfo / references / definition / diagnostic-parity).

// A top-level mixin, consumed by a class nested in a function.
@mixin()
class Labeled {
    label(): string {
        return "labeled"
    }
}

function makeLabeledConsumer(): string {
    class NestedConsumer implements Labeled {
    }

    return new NestedConsumer().label()
}

// A `@mixin` declared INSIDE a function, consumed locally in the same scope.
function makeLocalMixinConsumer(): string {
    @mixin()
    class LocalGreeter {
        greet(): string {
            return "hi"
        }
    }

    class LocalUser implements LocalGreeter {
    }

    return new LocalUser().greet()
}

// Two same-named nested mixins in sibling scopes each expand from their OWN declaration.
function buildWidgetA(): string {
    @mixin()
    class Widget {
        a(): string {
            return "A"
        }
    }

    class UseA implements Widget {
    }

    return new UseA().a()
}

function buildWidgetB(): string {
    @mixin()
    class Widget {
        b(): string {
            return "B"
        }
    }

    class UseB implements Widget {
    }

    return new UseB().b()
}

// A consumer nested inside a plain block (not a function body).
function makeBlockConsumer(): string {
    {
        class BlockConsumer implements Labeled {
        }

        return new BlockConsumer().label()
    }
}

it("nested-scope mixin and consumer declarations work at runtime", async (t: Test) => {
    t.equal(makeLabeledConsumer(), "labeled", "nested consumer of a top-level mixin")
    t.equal(makeLocalMixinConsumer(), "hi", "nested mixin consumed locally")
    t.equal(buildWidgetA(), "A", "first same-named nested mixin")
    t.equal(buildWidgetB(), "B", "second same-named nested mixin from its own declaration")
    t.equal(makeBlockConsumer(), "labeled", "nested consumer inside a plain block")
})
