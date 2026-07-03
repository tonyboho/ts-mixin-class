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
