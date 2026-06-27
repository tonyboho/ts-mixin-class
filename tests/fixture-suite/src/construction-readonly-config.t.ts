import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base } from "ts-mixin-class/base"

// §7 boundary: a construction class with **readonly** data fields — the immutable
// value-object pattern. Per design (confirmed): a readonly field IS part of `.new`'s
// config (construction is the one assignment readonly permits; `.new`'s `Object.assign`
// runs once in `initialize`), AND it stays **immutable on the constructed instance**
// (post-construction reassignment is a type error). Both halves are asserted here; the
// `@ts-expect-error` on the mutation also proves the readonly is actually enforced (an
// unused directive would redden as TS2578).
class Point extends Base {
    public readonly x!: number
    public readonly y!: number
    public label!: string = ""
}

const p = Point.new({ x : 1, y : 2, label : "origin-ish" })

const t1: number = p.x
const t2: number = p.y
const t3: string = p.label

// Type-only negative checks (never executed).
function typeOnlyChecks(): void {
    // @ts-expect-error readonly field is immutable on the constructed instance.
    p.x = 9

    // @ts-expect-error readonly field is immutable on the constructed instance.
    p.y = 9

    // @ts-expect-error construction config still rejects unknown keys.
    Point.new({ x : 1, y : 2, bogus : true })
}
void typeOnlyChecks

// A mutable field on the same instance stays assignable.
p.label = "moved"

it("accepts readonly fields in .new config but keeps them immutable on the instance", async (t: Test) => {
    t.isInstanceOf(p, Point, ".new returns the value object")
    t.equal(p.x, 1, "readonly field assigned from .new config")
    t.equal(p.y, 2, "second readonly field assigned from .new config")
    t.equal(p.label, "moved", "mutable field alongside readonly fields stays writable")
})

void [ t1, t2, t3 ]
