import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base } from "ts-mixin-class/base"

// §7 boundary: a construction class that declares **accessors** alongside data fields.
// A get-only accessor is not assignable, so it must be **excluded** from `.new` config;
// the accessors still work on the constructed instance. (A *settable* accessor — get/set
// or set-only — arguably SHOULD be in the config, since `.new`'s runtime `Object.assign`
// would fire its setter; that desired behavior is currently unmet and pinned by the RED
// `tests/construction-accessor-config-shapes.t.ts`. This fixture only covers the parts
// that compile today.)
class Profile extends Base {
    public first!: string = ""
    public last!: string  = ""

    // get/set pair — not a config field.
    public get full(): string {
        return `${this.first} ${this.last}`
    }

    public set full(value: string) {
        const [ first, last ] = value.split(" ")
        this.first = first ?? ""
        this.last  = last ?? ""
    }

    // get-only accessor — not a config field either.
    public get initials(): string {
        return (this.first[0] ?? "") + (this.last[0] ?? "")
    }
}

const profile = Profile.new({ first : "Ada", last : "Lovelace" })

const t1: string = profile.full
const t2: string = profile.initials

// Type-only negative checks (never executed).
function typeOnlyChecks(): void {
    // @ts-expect-error `initials` (get-only accessor) is not assignable → not a config field.
    Profile.new({ first : "Ada", last : "Lovelace", initials : "AL" })
}
void typeOnlyChecks

it("excludes accessors from construction config but keeps them on the instance", async (t: Test) => {
    t.equal(profile.first, "Ada", "data field assigned from .new config")
    t.equal(profile.last, "Lovelace", "data field assigned from .new config")
    t.equal(profile.full, "Ada Lovelace", "get accessor computes on the constructed instance")
    t.equal(profile.initials, "AL", "get-only accessor computes on the constructed instance")

    profile.full = "Grace Hopper"
    t.equal(profile.first, "Grace", "set accessor mutates after construction")
    t.equal(profile.initials, "GH", "get-only accessor reflects the mutation")
})

void [ t1, t2 ]
