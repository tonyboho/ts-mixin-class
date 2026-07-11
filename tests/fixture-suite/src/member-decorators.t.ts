import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// MEMBER decorators (§2.8's member-level sibling). A consumer's decorated members are
// preserved through the heritage rewrite and their decorators run ONCE; a MIXIN's member
// decorators ride inside the factory's class declaration, so they run PER DISTINCT FACTUAL BASE.
// Base-less consumers seed the chain with the package `Empty` itself, so they all REUSE the
// mixin's canonical application — the decorators run once, exactly like a hand-written
// `extends`, and exactly like consumers of a required-base mixin sharing its base (the
// 2026-07 design decision; the per-consumer `$empty` class survives as a TYPE-only scaffold).
// In the fixture corpus this file also feeds the stress sweep (navigation,
// quickinfo, rename over decorated members).
//
// Builds under BOTH decorator modes: the factory emits a named class DECLARATION
// (`class __X$class extends base { … } return __X$class`), so legacy decorators are legal on
// the mixin's members too (they are TS1206 on class-EXPRESSION members). Rest-args + void
// return keeps the decorator shape valid for both modes' method, field, STATIC and getter
// positions; they only count calls. Mode-SPECIFIC shapes (standard get+set pair, standard
// auto-accessor, legacy parameter decorators) live in `tests/member-decorators.t.ts` — they
// cannot ride a dual-built fixture.
let mixinMethodDecorated  = 0
let mixinFieldDecorated   = 0
let mixinStaticDecorated  = 0
let mixinGetterDecorated  = 0
let consumerDecorated     = 0
let consumerStaticDecorated = 0

function auditMixinMethod(..._args: unknown[]): void {
    mixinMethodDecorated += 1
}

function auditMixinField(..._args: unknown[]): void {
    mixinFieldDecorated += 1
}

function auditMixinStatic(..._args: unknown[]): void {
    mixinStaticDecorated += 1
}

// An ACCESSOR decorator must sit on ONE half of the pair only: legacy mode rejects decorating
// both (TS1207); standard mode decorates get and set separately — the getter keeps the counts
// identical across the two builds.
function auditMixinGetter(..._args: unknown[]): void {
    mixinGetterDecorated += 1
}

function auditConsumer(..._args: unknown[]): void {
    consumerDecorated += 1
}

function auditConsumerStatic(..._args: unknown[]): void {
    consumerStaticDecorated += 1
}

@mixin()
class Audited {
    @auditMixinStatic
    static origin: string = "audited"

    @auditMixinStatic
    static describe(): string {
        return `origin:${Audited.origin}`
    }

    @auditMixinField
    count: number = 0

    @auditMixinMethod
    act(): string {
        return `acted:${this.count}`
    }

    @auditMixinGetter
    get doubled(): number {
        return this.count * 2
    }

    set doubled(input: number) {
        this.count = input / 2
    }
}

class Worker implements Audited {
    @auditConsumerStatic
    static kind: string = "worker"

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

    t.equal(mixinMethodDecorated, 1,
        "a mixin METHOD decorator runs ONCE — base-less consumers reuse the canonical application")
    t.equal(mixinFieldDecorated, 1, "…and the mixin FIELD decorator the same")
})

it("STATIC member decorators on consumers and mixins", async (t: Test) => {
    t.equal(mixinStaticDecorated, 2,
        "a mixin's STATIC decorators run once each (2 decorated statics × the one canonical application)")
    t.equal(consumerStaticDecorated, 1, "a consumer's static decorator runs ONCE")

    t.equal(Audited.describe(), "origin:audited", "the decorated static method stays callable on the mixin")
    t.equal((Worker as unknown as typeof Audited).describe(), "origin:audited",
        "…and is inherited by the consumer's constructor")
    t.equal(Worker.kind, "worker", "the consumer's own decorated static is preserved")
})

it("an ACCESSOR decorator (on the getter of the pair) on a mixin", async (t: Test) => {
    t.equal(mixinGetterDecorated, 1, "the getter decorator runs once — on the canonical application")

    const measured = new Clerk()

    measured.doubled = 42

    t.equal(measured.count, 21, "the decorated pair's SETTER still mutates through the consumer")
    t.equal(measured.doubled, 42, "…and the decorated GETTER computes")
})

// The canonical-application sharing itself: base-less consumers count decorator runs the
// same as consumers of a required-base mixin (whose shared base always cache-hit — the
// old per-consumer `$empty` roots made the two cases inconsistent), and an object-valued
// static initializes once, so consumers see ONE object through static inheritance.
let basedMixinDecorated = 0

function auditBasedMixin(..._args: unknown[]): void {
    basedMixinDecorated += 1
}

class Ground {
    ground(): string {
        return "ground"
    }
}

@mixin()
class BasedAudited extends Ground {
    static registry: string[] = []

    @auditBasedMixin
    act(): string {
        return "based-acted"
    }
}

@mixin()
class Registered {
    static log: string[] = []
}

class BasedWorker implements BasedAudited {
}

class BasedClerk implements BasedAudited {
}

class LogWorker implements Registered {
}

class LogClerk implements Registered {
}

void new BasedWorker()
void new BasedClerk()

it("base-less and required-base consumers share the canonical application alike", async (t: Test) => {
    t.equal(basedMixinDecorated, 1, "a required-base mixin's member decorator runs once for two consumers")
    t.equal(mixinMethodDecorated, 1, "…and a base-less mixin's counts the same — no per-consumer applications")
})

it("an object-valued mixin static is ONE object across base-less consumers", async (t: Test) => {
    const workerLog = (LogWorker as unknown as typeof Registered).log
    const clerkLog  = (LogClerk as unknown as typeof Registered).log

    t.isStrict(workerLog, clerkLog, "both consumers inherit the canonical application's static object")
    t.isStrict(workerLog, Registered.log, "…which is the mixin value's own static")

    workerLog.push("from-worker")

    t.equal(clerkLog.length, 1, "a mutation through one consumer is visible through the other — plain inheritance semantics")
})
