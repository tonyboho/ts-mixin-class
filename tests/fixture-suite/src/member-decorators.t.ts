import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// MEMBER decorators (§2.8's member-level sibling). A consumer's decorated members are
// preserved through the heritage rewrite and their decorators run ONCE; a MIXIN's member
// decorators ride inside the factory class expression, so they run PER APPLICATION —
// canonical class + each base-less consumer's own empty base — the §1.18 static-block
// semantics. In the fixture corpus this file also feeds the stress sweep (navigation,
// quickinfo, rename over decorated members).
//
// STANDARD-plane only (excluded from tsconfig.legacy.json): a mixin's member decorators are
// impossible under LEGACY decorators — the factory turns the mixin into a class EXPRESSION,
// and legacy decorators are not valid on class-expression members (TS1206, correctly spanned
// on the decorator). Rest-args + void return keeps the decorator shape valid for the standard
// mode's method AND field positions; they only count calls.
let mixinMethodDecorated = 0
let mixinFieldDecorated  = 0
let consumerDecorated    = 0

function auditMixinMethod(..._args: unknown[]): void {
    mixinMethodDecorated += 1
}

function auditMixinField(..._args: unknown[]): void {
    mixinFieldDecorated += 1
}

function auditConsumer(..._args: unknown[]): void {
    consumerDecorated += 1
}

@mixin()
class Audited {
    @auditMixinField
    count: number = 0

    @auditMixinMethod
    act(): string {
        return `acted:${this.count}`
    }
}

class Worker implements Audited {
    @auditConsumer
    work(): string {
        return this.act() + "/worked"
    }
}

class Clerk implements Audited {
}

const worker = new Worker()
const clerk  = new Clerk()

it("member decorators on consumers and mixins", async (t: Test) => {
    t.equal(worker.work(), "acted:0/worked", "the consumer's decorated member calls through the chain")
    t.equal(clerk.act(), "acted:0", "the mixin's decorated member works on a second consumer")

    t.equal(consumerDecorated, 1, "a consumer member decorator runs ONCE (the member is preserved, not re-created)")

    t.equal(mixinMethodDecorated, 3,
        "a mixin METHOD decorator runs per application — canonical + one per base-less consumer (§1.18 semantics)")
    t.equal(mixinFieldDecorated, 3, "…and the mixin FIELD decorator the same")
})
