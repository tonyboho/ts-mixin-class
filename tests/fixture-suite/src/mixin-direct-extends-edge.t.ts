import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

let applications = 0

@mixin()
class Reusable {
    static {
        applications++
    }

    label: string = "reusable"
}

// A mixin class is still a class: ordinary `extends` inherits its canonical application and
// must not create another factory layer.
class DirectSubclass extends Reusable {
    own: string = "direct"
}

// Edge, UNSPECIFIED behavior (2026-07 decision): re-listing an inherited mixin on a subclass
// of a consumer is outside the mixin machinery's dedup scope — the base consumer is plain
// class inheritance, and dedup lives only WITHIN one consumer's C3 merge plus the
// per-factual-base application cache. Users should prefer NOT to relist an inherited mixin.
// The CURRENT behavior is pinned below so a change is noticed, not promised: a fresh layer
// applies, so the mixin's static block (and decorators / field initializers) run once per
// application layer — once for the canonical class, once more for the re-listed layer over
// `FirstConsumer`. Members and `instanceof` are unaffected either way.
class FirstConsumer implements Reusable {
}

class ReappliedConsumer extends FirstConsumer implements Reusable {
}

const direct = new DirectSubclass()
const first = new FirstConsumer()
const reapplied = new ReappliedConsumer()

it("a direct subclass uses the canonical mixin class; re-listing over a consumer base applies a fresh layer", async (t: Test) => {
    // 1 = the canonical application (defineMixinClass); the base-less FirstConsumer reuses it.
    // 2 = the re-listed layer over FirstConsumer (by design, see the note above).
    t.equal(applications, 2, "canonical application is shared; the re-listed consumer layer applies once more")
    t.equal(direct.label, "reusable", "ordinary extends reaches the mixin member")
    t.equal(direct.own, "direct", "the direct subclass keeps its own member")
    t.equal(first.label, "reusable", "the first consumer applies the mixin")
    t.equal(reapplied.label, "reusable", "the subclass still reaches the inherited mixin member")
    t.isInstanceOf(direct, Reusable, "the ordinary subclass is a mixin instance")
    t.isInstanceOf(reapplied, Reusable, "the inherited/relisted consumer is a mixin instance")
})
