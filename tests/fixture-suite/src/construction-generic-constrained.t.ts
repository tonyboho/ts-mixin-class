import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base } from "ts-mixin-class/base"

// §7 boundary: a construction class with a **constrained** generic parameter
// (`T extends { id: string }`). The generated `static new<T extends …>` and the exported
// `<ClassName>Config<T extends …>` alias must carry the constraint verbatim (deep-cloned
// type params), and `.new<T>` inference / explicit type args must respect it. Existing
// generic construction fixtures use only unconstrained parameters.
class Entity {
    id: string = ""
}

class Registry<T extends Entity> extends Base {
    public head: T | undefined
    public count: number = 0
}

const a = Registry.new({ head : { id : "a" }, count : 1 })
const headId: string = a.head!.id
const count: number = a.count

// Explicit constrained type argument.
class User extends Entity {
    name: string = ""
}

const users = Registry.new<User>({ head : { id : "u", name : "Ada" }, count : 1 })
const userName: string = users.head!.name

// Type-only negative checks (never executed).
function typeOnlyChecks(): void {
    // @ts-expect-error number does not satisfy `T extends Entity`.
    Registry.new<number>({ head : 1, count : 0 })

    // @ts-expect-error config object missing the constraint-required `id`.
    Registry.new<User>({ head : { name : "no id" }, count : 0 })

    // @ts-expect-error construction config excludes unknown keys.
    Registry.new({ head : { id : "x" }, count : 0, bogus : true })
}
void typeOnlyChecks

it("constructs a constrained generic class and preserves the constraint", async (t: Test) => {
    t.isInstanceOf(a, Registry, "constrained generic construction returns the instance")
    t.equal(a.head!.id, "a", "inferred constrained generic config is assigned")
    t.equal(a.count, 1, "non-generic config alongside a constrained generic is assigned")
    t.equal(users.head!.name, "Ada", "explicit constrained type argument widens the config shape")
})

void [ headId, count, userName ]
