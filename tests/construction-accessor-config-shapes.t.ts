import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput } from "./util.js"
import { buildConstructionSource, readConstructionConfigDts } from "./construction-build-util.js"

// ACCESSORS as `.new` config keys, in every shape (§7.5c/d/e/g): a construction class's own
// settable accessor, a SPLIT pair typed by the setter, a MIXIN-contributed accessor flowing
// into the consumer's config, and a mixin's GENERIC split accessor with the type parameter
// substituted. The runtime counterparts live in the fixture corpus
// (`fixture-suite/src/construction-accessor-config.t.ts` pins the get-only exclusion).

// §7.5c: a construction class's generated `<ClassName>Config` includes a **settable**
// accessor (a get/set pair or a set-only accessor), because such an accessor is a public,
// assignable member — and `.new`'s runtime config assignment is `Object.assign(this, props)`,
// whose `[[Set]]` semantics fire the accessor's setter. So `.new({ full: "…" })` compiles
// and runs the setter. The config used to be built from data fields only, rejecting a
// settable accessor with TS2353.
//
// A get-only accessor stays excluded (not assignable) — that part is covered green by
// `fixture-suite/src/construction-accessor-config.t.ts`.
const settableAccessorConfigText = `
import { Base } from "ts-mixin-class/base"

class Profile extends Base {
    // optional data fields so the config requirement under test is purely the accessor
    public first?: string
    public last?: string

    // get/set pair: settable -> should be in the construction config
    public get full(): string {
        return (this.first ?? "") + " " + (this.last ?? "")
    }

    public set full(value: string) {
        const parts = value.split(" ")
        this.first = parts[0] ?? ""
        this.last = parts[1] ?? ""
    }

    // set-only accessor: also settable -> should be in the construction config
    public set initials(value: string) {
        this.first = value[0] ?? ""
        this.last = value[1] ?? ""
    }
}

// Desired: both settable accessors are part of the construction config.
const p = Profile.new({ full: "Ada Lovelace" })
const q = Profile.new({ initials: "AL" })

void [ p.first, p.last, p.full, q.first ]
`

it("includes a settable accessor in the construction config", async (t: Test) => {
    const emitResult       = await buildConstructionSource(settableAccessorConfigText, undefined)
    const sourceViewResult = await buildConstructionSource(settableAccessorConfigText, { noEmit: true })

    t.equal(
        emitResult.exitCode,
        0,
        `A settable accessor should be accepted by .new config (emit).\n${commandOutput(emitResult)}`
    )

    t.equal(
        sourceViewResult.exitCode,
        0,
        `A settable accessor should be accepted by .new config (source-view).\n${commandOutput(sourceViewResult)}`
    )
})

// SPEC (§7.5c): a settable accessor is included in `.new` config "typed by the SETTER's
// parameter type". This matters when the getter and setter types DIFFER (a getter that
// returns a narrow type, a setter that accepts a wider one — legal since TS 4.3). Because
// `.new`'s runtime is `Object.assign`, which invokes the setter, the config field should
// accept anything the SETTER accepts (`number | string`), not only the getter's type.
//
// This test asserts `.new({ value: "str" })` compiles (a setter-valid, getter-invalid
// value). The generated `<Class>Config` emits a settable accessor as an explicit
// `value?: <setterParamType>` member (not `Pick<Class, "value">`, which would read the
// GETTER type `number`), so a setter-valid argument is accepted in emit and source-view.
const splitAccessorText = `
import { Base } from "ts-mixin-class/base"

class Model extends Base {
    public id: string = ""

    // private backing storage — excluded from config, so 'id' is the only required field
    private _v: number = 0

    public get value(): number {
        return this._v
    }

    // setter accepts a WIDER type than the getter returns
    public set value(input: number | string) {
        this._v = typeof input === "string" ? input.length : input
    }
}

// A setter-valid (getter-invalid) argument: the setter accepts a string, normalizes it.
const fromString = Model.new({ id: "a", value: "hello" })
const fromNumber = Model.new({ id: "b", value: 3 })

// 'value' is optional (accessor) — may be omitted.
const minimal = Model.new({ id: "c" })

void [ fromString.value, fromNumber.value, minimal.value ]
`

it("types a split get/set accessor in .new config by the setter parameter type", async (t: Test) => {
    const emit       = await buildConstructionSource(splitAccessorText, undefined)
    const sourceView = await buildConstructionSource(splitAccessorText, { noEmit: true })

    t.equal(
        emit.exitCode,
        0,
        `.new should accept a setter-valid value for a split get/set accessor (emit).\n${commandOutput(emit)}`
    )
    t.equal(
        sourceView.exitCode,
        0,
        `.new should accept a setter-valid value for a split get/set accessor (source-view).\n${commandOutput(sourceView)}`
    )
})

// §7.5e: §7.5c established that a construction class's OWN public settable accessor is part
// of its `.new` config. This pins the next dimension — a settable accessor contributed by a
// MIXIN the construction consumer implements. `.new`'s `Object.assign` fires the inherited
// setter the same way, so the mixin's settable accessor is aggregated into the consumer's
// config (as an optional key), alongside the mixin's public DATA fields (required unless
// `?`). Here `label` (a get/set pair on the mixin) is optional config; `tag` (a required
// mixin data field) shows the two coexist.
const mixinAccessorText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Labelled {
    public backing?: string

    public tag: string = ""

    public get label(): string {
        return this.backing ?? ""
    }

    public set label(value: string) {
        this.backing = value
    }
}

class Widget extends Base implements Labelled {
    public id: string = ""
}

// The mixin's settable accessor 'label' is optional config; 'tag' (required mixin field)
// and 'id' (the consumer's own required field) are required.
const configured = Widget.new({ id: "w1", tag: "t", label: "hello" })

// 'label' may be omitted (optional); the required fields are still enforced.
const minimal = Widget.new({ id: "w2", tag: "t2" })

void [ configured.label, minimal.label ]

// @ts-expect-error 'label' is typed by the setter — a number is rejected.
Widget.new({ id: "w3", tag: "t3", label: 42 })
`

// Same consumer + mixin without any `.new(...)` call, so declarations emit cleanly and the
// generated `WidgetConfig` alias can be inspected directly.
const mixinAccessorInspectionText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Labelled {
    public backing?: string

    public get label(): string {
        return this.backing ?? ""
    }

    public set label(value: string) {
        this.backing = value
    }
}

export class Widget extends Base implements Labelled {
    public id: string = ""
}
`

it("aggregates a mixin's settable accessor into the consumer's .new config", async (t: Test) => {
    const emit       = await buildConstructionSource(mixinAccessorText, undefined)
    const sourceView = await buildConstructionSource(mixinAccessorText, { noEmit: true })

    t.equal(
        emit.exitCode,
        0,
        `A mixin's settable accessor is part of the consumer's .new config (emit).\n${commandOutput(emit)}`
    )
    t.equal(
        sourceView.exitCode,
        0,
        `A mixin's settable accessor is part of the consumer's .new config (source-view).\n${commandOutput(sourceView)}`
    )

    const dts = await readConstructionConfigDts(mixinAccessorInspectionText)

    // The mixin's settable accessor is emitted as an explicit `label?: string` config
    // member (typed by the setter), not folded into the data-field `Pick<...>`.
    t.match(
        dts,
        "label?: string",
        `the consumer config alias carries the mixin's settable accessor.\n--- source.d.ts ---\n${dts}`
    )
})

// §7.5d × §7.5e × §6: a MIXIN's GENERIC settable accessor whose getter and setter types
// DIFFER and both depend on the mixin's type parameter `T` (`get value(): T`,
// `set value(input: T | string)`), flowing into a construction CONSUMER that fixes `T`.
//
// The consumer's `.new` config key for `value` must be typed by the SETTER parameter type
// with `T` SUBSTITUTED to the consumer's argument — here `Boxed<number>`, so
// `value?: number | string`. The failure modes this pins:
//   - a dangling `T` (the setter's type node cloned without substitution → `T` is unbound),
//   - the GETTER type `number` (a `Pick`-fallback), which would reject the string below.
const genericAccessorText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Boxed<T> {
    public backing?: T | string

    public get value(): T {
        return this.backing as T
    }

    public set value(input: T | string) {
        this.backing = input
    }
}

class Box extends Base implements Boxed<number> {
    public id: string = ""
}

// 'value' is typed by the setter with T = number => 'number | string': BOTH compile.
const withString = Box.new({ id: "b1", value: "hello" })
const withNumber = Box.new({ id: "b2", value: 7 })

// 'value' is optional (settable accessor); the required own field is still enforced.
const minimal = Box.new({ id: "b3" })

void [ withString.value, withNumber.value, minimal.value ]

// @ts-expect-error the setter accepts number | string; a boolean is rejected.
Box.new({ id: "b4", value: true })
`

// Same consumer + mixin without any `.new(...)` call, so declarations emit cleanly and the
// generated `BoxConfig` alias can be inspected directly.
const genericAccessorInspectionText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Boxed<T> {
    public backing?: T | string

    public get value(): T {
        return this.backing as T
    }

    public set value(input: T | string) {
        this.backing = input
    }
}

export class Box extends Base implements Boxed<number> {
    public id: string = ""
}
`

// A consumer that FORWARDS its own type parameter to the mixin (`class Box<U> ... implements
// Boxed<U>`): the substitution maps the mixin's `T` -> the consumer's `U`, which is in scope
// in the generic `BoxConfig<U>` alias, so `value?: U | string` is well-formed (not a dangling
// `T`). Guards the substitution's type-reference (forwarding) branch, distinct from the
// concrete-argument branch above.
const forwardingInspectionText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Boxed<T> {
    public backing?: T | string

    public get value(): T {
        return this.backing as T
    }

    public set value(input: T | string) {
        this.backing = input
    }
}

export class Box<U> extends Base implements Boxed<U> {
    public id: string = ""
}
`

it("types a mixin's generic split accessor in the consumer's .new config by the substituted setter type", async (t: Test) => {
    const emit       = await buildConstructionSource(genericAccessorText, undefined)
    const sourceView = await buildConstructionSource(genericAccessorText, { noEmit: true })

    t.equal(
        emit.exitCode,
        0,
        `A mixin's generic split accessor flows into the consumer .new config typed by the setter (emit).\n${commandOutput(emit)}`
    )
    t.equal(
        sourceView.exitCode,
        0,
        `A mixin's generic split accessor flows into the consumer .new config typed by the setter (source-view).\n${commandOutput(sourceView)}`
    )

    const dts = await readConstructionConfigDts(genericAccessorInspectionText)

    // The setter type `T | string` is substituted to the consumer's argument: `number | string`.
    t.match(
        dts,
        "value?: number | string",
        `the consumer config alias types the mixin's generic split accessor by the substituted setter type.\n--- source.d.ts ---\n${dts}`
    )
})

it("forwards the consumer's own type parameter into the mixin's generic split accessor config", async (t: Test) => {
    const dts = await readConstructionConfigDts(forwardingInspectionText)

    // The mixin's `T` is substituted to the consumer's forwarded `U`, in scope in `BoxConfig<U>`.
    t.match(
        dts,
        "value?: U | string",
        `the generic consumer config alias forwards its own type parameter into the accessor type.\n--- source.d.ts ---\n${dts}`
    )
})
