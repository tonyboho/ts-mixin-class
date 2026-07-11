import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { transformSourceFile } from "../src/index.js"
import { createSourceFile } from "./util.js"

// Regression (deterministic replacement for a flaky stress-edit seed, e.g.
// MIXIN_STRESS_SEED=1441544766): a `@mixin` class whose `implements` entry is not a plain
// identifier / qualified name — a string literal, call, element-access, etc., as a transient
// mid-edit easily produces — must NOT crash the transform. The source-view mixin path
// (`createSourceViewMixinInstanceType` → `heritageTypeToTypeReference` → `expressionToEntityName`)
// mapped over the `implements` heritage types with no `isSupportedBaseExpression` guard (unlike
// the already-guarded required base), so it threw "Unsupported base class expression of a mixin
// consumer", taking down the language service mid-keystroke. The transform must degrade
// gracefully — the contract `stress-edit` enforces: never throw on any edit state.

const unsupportedHeritage = [
    "\"x\"",        // string literal (the exact kind a deletion produced under the seed above)
    "factory()",    // call expression
    "bases[0]",     // element access
    "factory().Inner" // property access on a call (recurses to an unsupported expression)
]

// Regression (deterministic replacement for stress-edit seed MIXIN_STRESS_SEED=386732370):
// a half-typed "[" member inside a class (`static[ built: string = ""`) parses as a
// MALFORMED IndexSignatureDeclaration (no closing bracket, no type). The nested-scope
// expansion walk (`expandNestedStatementLists` → `visitEachChild`) hit TypeScript's own
// `visitEachChildOfIndexSignatureDeclaration` Debug assertion on the missing type and
// crashed the emit-plane transform mid-keystroke. The walk must skip an unvisitable
// subtree instead — the next complete parse restores it.
it("does not throw on a class member that parses as a malformed index signature", async (t: Test) => {
    // The nested consumer in makeNested is what routes the file through the nested
    // statement-list walk (`hasNestedClasses`) — without it the malformed class is never
    // visited and the crash cannot reproduce.
    const sourceText = `
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Labeled {
            label(): string {
                return "x"
            }
        }

        function makeNested(): string {
            class NestedConsumer implements Labeled {
            }

            return new NestedConsumer().label()
        }

        class StaticBlockHost {
            static[ built: string = ""

            static {
                class StaticBlockConsumer implements Labeled {
                }

                void StaticBlockConsumer
            }
        }

        void makeNested
    `

    t.doesNotThrow(
        () => transformSourceFile(ts, createSourceFile(sourceText)),
        "emit tolerates a half-typed index-signature member on the nested-scope walk"
    )
    t.doesNotThrow(
        () => transformSourceFile(ts, createSourceFile(sourceText), { sourceView: true }),
        "source view tolerates it too"
    )
})

it("does not throw on a @mixin class with an unsupported (non-reference) implements entry", async (t: Test) => {
    for (const heritage of unsupportedHeritage) {
        // The `.mix(...)` usage stays deliberately: the crashing apply-type build it used
        // to trigger is gone (program-local `.mix` is banned — TS990012), so today it
        // exercises the ban SCAN against the same unsupported-heritage states — pushing a
        // diagnostic must never throw either.
        const sourceText = `
            import { mixin } from "ts-mixin-class"

            @mixin()
            class Broken implements ${heritage} {
                value: string = ""
            }

            const Mixed = Broken.mix(Object)

            void [ Broken, Mixed ]
        `

        t.doesNotThrow(
            () => transformSourceFile(ts, createSourceFile(sourceText), { sourceView: true }),
            `source view tolerates a mixin 'implements ${heritage}'`
        )
        t.doesNotThrow(
            () => transformSourceFile(ts, createSourceFile(sourceText)),
            `emit tolerates a mixin 'implements ${heritage}'`
        )
    }
})
