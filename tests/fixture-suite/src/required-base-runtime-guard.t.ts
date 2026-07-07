import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { mixin } from "ts-mixin-class"

// §4.5 runtime boundary: the required-base constraint is enforced at *runtime* too,
// not only by the compiler. `.mix(Unrelated)` where `Unrelated` does not descend from
// the mixin's required base throws (`applyRuntimeMixin` -> `classExtends` is false).
// The compile-time rejection is covered by `generic-mixin-type-params.t.ts`, and the
// raw runtime helper (`mixinChain` + `defineMixinClass`) by `runtime-helper.t.ts`. This
// probes the *transformer-emitted* `.mix` of a real `@mixin()` class end-to-end — a
// distinct plane: a regression in how the emitted `.mix` wires through to the guard
// would slip past the raw-helper test. Reached by bypassing the static `.mix` signature.
class RequiredBase {
    requiredValue: string = "required"
}

class RelatedBase extends RequiredBase {
    relatedValue: string = "related"
}

class Unrelated {
    unrelatedValue: string = "unrelated"
}

@mixin()
class NeedsBase extends RequiredBase {
    mixinValue: string = "mixin"
}

// Erase the strict `.mix` signature so the runtime guard — not the type system — is
// what rejects the unrelated base.
const looseMix = (NeedsBase as unknown as { mix(base: unknown): unknown }).mix

it("enforces the required base at runtime when the type check is bypassed", async (t: Test) => {
    t.throwsOk(
        () => looseMix(Unrelated),
        "requires base",
        "mixing onto a base that does not descend from the required base throws at runtime"
    )

    // A base that *does* descend from the required base applies cleanly.
    const Applied = looseMix(RelatedBase) as new () => RequiredBase & RelatedBase & NeedsBase
    const instance = new Applied()

    t.equal(instance.requiredValue, "required", "required-base field present on a valid application")
    t.equal(instance.relatedValue, "related", "intermediate-base field present")
    t.equal(instance.mixinValue, "mixin", "mixin field present")
    t.isInstanceOf(instance, RequiredBase, "applied instance descends from the required base")
})
