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

// A nested `@mixin` shadowing a top-level one of the same name: the nested consumer resolves
// the nested mixin (lexical), the top-level consumer keeps the top-level mixin.
@mixin()
class Shadowed {
    top(): string {
        return "top"
    }
}

function makeShadowingConsumer(): string {
    @mixin()
    class Shadowed {
        inner(): string {
            return "inner"
        }
    }

    class ShadowUser implements Shadowed {
    }

    const user = new ShadowUser()

    // Type-level proof that the nested `Shadowed` is a DIFFERENT class than the top-level one:
    // it has `inner` but not the top-level `top`, so reaching for `top` here is a type error.
    // @ts-expect-error nested Shadowed has no `top` member (that belongs to the shadowed top-level mixin)
    void user.top

    return user.inner()
}

class TopShadowConsumer implements Shadowed {
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
    t.equal(makeShadowingConsumer(), "inner", "nested mixin shadowing a top-level name")
    t.equal(new TopShadowConsumer().top(), "top", "top-level mixin keeps its own member under shadowing")
    t.equal(makeBlockConsumer(), "labeled", "nested consumer inside a plain block")
})
