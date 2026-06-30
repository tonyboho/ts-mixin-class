import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base, mixin } from "ts-mixin-class"

// A construction-base mixin (one that extends the package `Base`) used on its
// own, i.e. constructed directly via `Mixin.new(...)` rather than through a
// consumer. Its generated `new` must return the mixin's own instance type.
@mixin()
class Serializable extends Base {
    public format?: string = "json"
    public revision?: number = 1
}

// Regression: `Serializable.new()` previously resolved to `Base`, so this
// assignment failed to compile with "Property 'format' is missing in type
// 'Base'". It must now type as the mixin instance in both the emit value cast
// and the source-view class form.
const created: Serializable = Serializable.new()
const configured: Serializable = Serializable.new({ format: "xml", revision: 2 })

// A construction (Base-deriving) mixin is built only through the static `.new`; a direct `new`
// is a compile-time type error. The brand is compile-time-only, so the runtime still builds an
// instance (asserted below).
// @ts-expect-error direct `new` on a construction mixin is disabled; use the static `new`.
const directSerializable = new Serializable()

// A construction mixin MAY still declare its own constructor: it is preserved and runs as the
// native-construct step of `.new()`. (The EMIT plane also disables a direct `new Tracked()`; that
// ban is pinned in `source-transform-mixins` rather than here, because source view deliberately
// leaves the with-constructor case un-banned — so a `@ts-expect-error new Tracked()` would be
// "unused" under the IDE/tsserver check of this same file.)
@mixin()
class Tracked extends Base {
    seq: number
    log: string[]

    constructor () {
        super()

        this.seq = 1
        this.log = [ "ctor" ]
    }

    bump (): number {
        return ++this.seq
    }
}

const tracked: Tracked = Tracked.new()

it("constructs a standalone construction-base mixin through its own static new", async (t: Test) => {
    t.isInstanceOf(created, Serializable, "Mixin.new() returns an instance of the mixin")
    t.equal(created.format, "json", "Field initializer is preserved for the no-config call")
    t.equal(created.revision, 1, "Field initializer is preserved for the no-config call")
    t.equal(configured.format, "xml", "new(config) assigns public config fields")
    t.equal(configured.revision, 2, "new(config) assigns public config fields")
})

it("runs a construction mixin's own constructor through the static new", async (t: Test) => {
    t.isInstanceOf(tracked, Tracked, "Tracked.new() returns an instance of the mixin")
    t.equal(tracked.seq, 1, "The mixin's own constructor body runs during .new()")
    t.equal(tracked.log.join(","), "ctor", "The constructor's side effects are observable")
    t.equal(tracked.bump(), 2, "Methods see constructor-assigned state")

    // The disabled-`new` brand is compile-time-only; the runtime still constructs.
    t.isInstanceOf(directSerializable, Serializable, "Compile-time-only guard still builds an instance")
})

void [ created, configured, directSerializable, tracked ]
