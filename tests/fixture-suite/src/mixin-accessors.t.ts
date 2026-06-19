import { mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §1.1 boundary: a mixin contributing accessors (get-only and a get/set pair) — a
// separate transformer path from plain methods/fields (`accessorSignature` models a
// get-only accessor as a `readonly` property and a get/set pair as a writable one).
// Both the static type and the runtime accessor semantics are asserted here.
@mixin()
class NameMixin {
    firstName: string = "Ada"
    lastName: string  = "Lovelace"

    // get-only: should surface as a `readonly` property on the consumer.
    get fullName(): string {
        return this.firstName + " " + this.lastName
    }

    // get/set pair: should surface as a writable property; the setter mutates state
    // that the getter reflects.
    get primary(): string {
        return this.firstName
    }

    set primary(value: string) {
        this.firstName = value
    }
}

class Base {
    baseValue: number = 1
}

class Consumer extends Base implements NameMixin {
}

const c = new Consumer()

const t1: string = c.fullName
const t2: string = c.primary

// Type-only negative checks (never executed — assigning to a real get-only accessor
// would throw at runtime, which is itself the proof the descriptor stays get-only).
function typeOnlyChecks(): void {
    // @ts-expect-error fullName is get-only → modeled as a readonly property.
    c.fullName = "Grace Hopper"

    // @ts-expect-error the get/set pair rejects a non-string.
    c.primary = 42
}
void typeOnlyChecks

// A standalone instance of the mixin keeps the accessors too.
const canonical = new NameMixin()
const t3: string = canonical.fullName

it("mixin accessors", async (t: Test) => {
    t.equal(c.fullName, "Ada Lovelace", "get-only accessor computes from mixin fields on the consumer")
    t.equal(c.primary, "Ada", "get accessor of the get/set pair reads through")

    c.primary = "Grace"
    t.equal(c.primary, "Grace", "setter of the get/set pair mutates state")
    t.equal(c.fullName, "Grace Lovelace", "get-only accessor reflects the mutation done via the setter")

    let descriptor: PropertyDescriptor | undefined
    for (let proto = Object.getPrototypeOf(c); proto && !descriptor; proto = Object.getPrototypeOf(proto)) {
        descriptor = Object.getOwnPropertyDescriptor(proto, "fullName")
    }
    t.ok(descriptor && typeof descriptor.get === "function" && descriptor.set === undefined,
        "get-only accessor stays a real get-only descriptor on the prototype chain (not a copied value)")

    t.equal(canonical.fullName, "Ada Lovelace", "standalone mixin instance keeps its accessors")
})

void [ t1, t2, t3 ]
