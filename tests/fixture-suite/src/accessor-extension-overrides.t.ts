import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// The ALLOWED side of the partial-accessor-override guard (TS990011 rejects narrowing): an
// override may EXTEND the overridden accessor's half-set or replace it whole — nothing dies at
// runtime, because the nearer descriptor carries every half the deeper one had. The runtime
// behavior of each legal shape is pinned here; the rejected shapes live in
// tests/partial-accessor-overrides.t.ts (they must not compile).

@mixin()
class GetOnlyMixin {
    get label(): string {
        return "from-mixin"
    }
}

// extension: the full pair over the mixin's get-only
class ExtendingUser implements GetOnlyMixin {
    public backing: string = "own"

    override get label(): string {
        return this.backing
    }

    override set label(value: string) {
        this.backing = value
    }
}

// same half over the same half — a plain replacement
class SameHalfUser implements GetOnlyMixin {
    override get label(): string {
        return "replaced"
    }
}

// an auto-accessor over the get-only — a full pair via the generated backing slot
class AutoOverGet implements GetOnlyMixin {
    override accessor label: string = "auto"
}

@mixin()
class PairMixin {
    public stored: number = 3

    get x(): number {
        return this.stored
    }

    set x(value: number) {
        this.stored = value
    }
}

// the full pair over the full pair — an ordinary override
class FullOverFull implements PairMixin {
    public own: number = 0

    override get x(): number {
        return this.own
    }

    override set x(value: number) {
        this.own = value
    }
}

it("extending accessor overrides keep both halves alive at runtime", (t: Test) => {
    const extended = new ExtendingUser()

    t.equal(extended.label, "own", "the extending pair reads through its own getter")

    extended.label = "written"

    t.equal(extended.label, "written", "…and the ADDED setter works (nothing died)")

    const viaMixin: GetOnlyMixin = extended

    t.equal(viaMixin.label, "written", "reads through the mixin-typed view reach the override")

    t.equal(new SameHalfUser().label, "replaced", "a same-half override is a plain replacement")

    const auto = new AutoOverGet()

    t.equal(auto.label, "auto", "the auto-accessor override reads its backing slot")

    auto.label = "slotted"

    t.equal(auto.label, "slotted", "…and writes it — the auto pair is complete")

    const full = new FullOverFull()

    full.x = 11

    t.equal(full.x, 11, "a pair-over-pair override behaves as an ordinary override")
    t.equal(full.own, 11, "…through the consumer's own backing")
    t.equal(full.stored, 3, "…leaving the mixin's backing untouched")
})
