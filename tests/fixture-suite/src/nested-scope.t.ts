import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { mixin } from "ts-mixin-class"
import { Base } from "ts-mixin-class/base"

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

// A nested CONSTRUCTION class (extends the package `Base`): gets its generated static `.new(...)`
// factory and its `<Name>Config` alias in the same block, and constructs through `Base.new`.
function makeConstructed(): { id: string, balance: number } {
    class Account extends Base {
        public id!: string = ""
        public balance!: number = 0
    }

    return Account.new({ id: "a1", balance: 100 })
}

// A consumer nested inside a plain block (not a function body).
function makeBlockConsumer(): string {
    {
        class BlockConsumer implements Labeled {
        }

        return new BlockConsumer().label()
    }
}

// A consumer declared directly in a `switch` CASE CLAUSE (a statement list that is not a
// `Block`), and a braced default clause with its own local mixin.
function pickByKind(kind: number): string {
    switch (kind) {
        case 1:
            class CaseConsumer implements Labeled {
            }

            return new CaseConsumer().label()
        default: {
            @mixin()
            class DefaultMixin {
                d(): string {
                    return "default"
                }
            }

            class DefaultConsumer implements DefaultMixin {
            }

            return new DefaultConsumer().d()
        }
    }
}

// A consumer declared in a class METHOD body and in a GETTER body.
class NestingHost {
    fromMethod(): string {
        class MethodConsumer implements Labeled {
        }

        return new MethodConsumer().label()
    }

    get viaGetter(): string {
        class GetterConsumer implements Labeled {
        }

        return new GetterConsumer().label()
    }
}

// A mixin + consumer declared in an ARROW function body.
const makeArrowConsumer = (): string => {
    @mixin()
    class ArrowMixin {
        arrow(): string {
            return "arrow"
        }
    }

    class ArrowConsumer implements ArrowMixin {
    }

    return new ArrowConsumer().arrow()
}

// A consumer declared inside a `static {}` INITIALIZATION BLOCK — a Block owned by a class
// member, composing the nested-scope splice with static-block support (§1.18/§2.9).
class StaticBlockHost {
    static built: string = ""

    static {
        class StaticBlockConsumer implements Labeled {
        }

        StaticBlockHost.built = new StaticBlockConsumer().label()
    }
}

// Consumers declared in TRY / CATCH / FINALLY blocks (each is a plain Block with a distinct
// parent kind).
function makeTryCatchConsumers(): string {
    let out = ""

    try {
        class InTry implements Labeled {
        }

        out = new InTry().label()
        throw new Error("reach the catch")
    } catch {
        class InCatch implements Labeled {
        }

        out += "+" + new InCatch().label()
    } finally {
        class InFinally implements Labeled {
        }

        out += "+" + new InFinally().label()
    }

    return out
}

// A nested consumer with its OWN constructor using a PARAMETER PROPERTY.
function makeParamPropertyConsumer(): string {
    class Tagged implements Labeled {
        constructor(public tag: string) {}
    }

    const tagged = new Tagged("t1")

    return tagged.label() + ":" + tagged.tag
}

// A mixin + consumer declared in a NAMESPACE (ModuleBlock).
namespace nesting {
    @mixin()
    export class NsMixin {
        ns(): string {
            return "namespace"
        }
    }

    export class NsConsumer implements NsMixin {
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

    const account = makeConstructed()
    t.equal(account.id, "a1", "nested construction class built its id through .new(...)")
    t.equal(account.balance, 100, "nested construction class built its balance through .new(...)")

    t.equal(pickByKind(1), "labeled", "consumer declared in a switch case clause")
    t.equal(pickByKind(0), "default", "mixin + consumer in a braced default clause")
    t.equal(new NestingHost().fromMethod(), "labeled", "consumer declared in a class method body")
    t.equal(new NestingHost().viaGetter, "labeled", "consumer declared in a getter body")
    t.equal(makeArrowConsumer(), "arrow", "mixin + consumer in an arrow function body")
    t.equal(new nesting.NsConsumer().ns(), "namespace", "mixin + consumer in a namespace")
    t.equal(StaticBlockHost.built, "labeled", "consumer declared inside a static initialization block")
    t.equal(makeTryCatchConsumers(), "labeled+labeled+labeled", "consumers in try / catch / finally blocks")
    t.equal(makeParamPropertyConsumer(), "labeled:t1", "nested consumer with a parameter-property constructor")
})
