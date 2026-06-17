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

it("constructs a standalone construction-base mixin through its own static new", async (t: Test) => {
    t.isInstanceOf(created, Serializable, "Mixin.new() returns an instance of the mixin")
    t.equal(created.format, "json", "Field initializer is preserved for the no-config call")
    t.equal(created.revision, 1, "Field initializer is preserved for the no-config call")
    t.equal(configured.format, "xml", "new(config) assigns public config fields")
    t.equal(configured.revision, 2, "new(config) assigns public config fields")
})

void [ created, configured ]
