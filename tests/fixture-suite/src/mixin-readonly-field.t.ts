import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.8 / §7.6a boundary: a mixin contributing a `readonly` DATA field (not a get-only
// accessor, and not a construction-class field — the two readonly shapes already covered).
// The `readonly` modifier must survive into the consumer's generated interface member:
// the field is present and initialized at runtime, but reassigning it on the consumer
// instance is a compile error.
@mixin()
class Identified {
    readonly id: string = "id-0"

    describe(): string {
        return `#${this.id}`
    }
}

class Entity implements Identified {
}

const e = new Entity()

const currentId: string = e.id

// Type-only negative check (never executed): the mixin's readonly field stays readonly
// on the consumer instance. (`readonly` is erased at runtime, so this must NOT run, or it
// would actually mutate `id`.)
function typeOnlyChecks(): void {
    // @ts-expect-error the mixin's readonly field stays readonly on the consumer instance.
    e.id = "id-9"
}
void typeOnlyChecks

it("mixin readonly field", async (t: Test) => {
    t.equal(e.id, "id-0", "the mixin's readonly field is initialized on the consumer at runtime")
    t.equal(e.describe(), "#id-0", "the readonly field is reachable through the mixin's own method")
    t.equal(currentId, "id-0", "the readonly field reads as its declared type on the consumer")
})

void currentId
