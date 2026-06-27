import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { mixin } from "ts-mixin-class"
import { Base } from "ts-mixin-class/base"


// fillMissedInitializersWith defaults to "undefined": a construction field written without an
// initializer is filled with `undefined` in the emit, giving every instance a stable object
// shape (an own slot) without widening the property type. This holds for fields of EVERY
// visibility (public/protected/private/unmarked), not only the public config fields — a stable
// shape is a runtime concern. (Mixins cannot have private/protected members, so the non-public
// fields live on the Base-descendant classes.)
class FilledShapeBase extends Base {
    public baseValue: number
    protected protectedValue: number
    unmarkedValue: number
}

class PlainFilledShape extends Base {
    public value: number
}

@mixin()
class FilledShapeMixin {
    public mixinValue: string

    mixinMethod(): string {
        return this.mixinValue
    }
}

class FilledShapeConsumer extends FilledShapeBase implements FilledShapeMixin {
    public ownValue: boolean
    private privateValue: string

    // Reads the private field (also keeps `noUnusedLocals` satisfied).
    snapshotPrivate(): string {
        return this.privateValue
    }
}

// Read a (possibly non-public) own property by key without a TypeScript visibility error.
function ownSlot(instance: object, key: string): unknown {
    return (instance as Record<string, unknown>)[key]
}

// Direct `new` on a construction class is disabled (construction goes through the
// generated static `new` factory). The brand is a compile-time-only guard, so the
// runtime still builds an unconfigured instance, which the assertions below check.
// @ts-expect-error direct `new` on a construction class is disabled; use the static `new`.
const unconfigured = new FilledShapeConsumer()
// @ts-expect-error direct `new` on a construction class is disabled; use the static `new`.
const plainUnconfigured = new PlainFilledShape()
const plainConfigured = PlainFilledShape.new({ value : 7 })
const configured = FilledShapeConsumer.new({
    baseValue  : 10,
    mixinValue : "configured",
    ownValue   : true
})

const t1: number = configured.baseValue
const t2: string = configured.mixinValue
const t3: boolean = configured.ownValue
const t4: string = configured.mixinMethod()
const t5: number = plainConfigured.value

// @ts-expect-error fillMissedInitializersWith does not widen required property types.
const e1: undefined = configured.baseValue

// @ts-expect-error fillMissedInitializersWith does not widen plain Base descendant property types.
const e2: undefined = plainConfigured.value

it("fills missed initializers for construction properties of every visibility to keep a stable shape", async (t: Test) => {
    t.true(Object.hasOwn(plainUnconfigured, "value"), "Plain Base descendant filled property keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "baseValue"), "Base filled property keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "mixinValue"), "Mixin filled property keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "ownValue"), "Consumer filled property keeps an own slot")

    // Non-public fields are filled too: each gets a real own slot at runtime, not just a
    // prototype lookup — that is the whole point of a stable object shape.
    t.true(Object.hasOwn(unconfigured, "protectedValue"), "A protected field keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "unmarkedValue"), "An unmarked field keeps an own slot")
    t.true(Object.hasOwn(unconfigured, "privateValue"), "A private field keeps an own slot")

    t.equal(plainUnconfigured.value, undefined as unknown as number,
        "Plain Base descendant filled property starts as undefined")
    t.equal(unconfigured.baseValue, undefined as unknown as number, "Base filled property starts as undefined")
    t.equal(unconfigured.mixinValue, undefined as unknown as string, "Mixin filled property starts as undefined")
    t.equal(unconfigured.ownValue, undefined as unknown as boolean, "Consumer filled property starts as undefined")

    t.equal(ownSlot(unconfigured, "protectedValue"), undefined, "Protected filled property starts as undefined")
    t.equal(ownSlot(unconfigured, "unmarkedValue"), undefined, "Unmarked filled property starts as undefined")
    t.equal(unconfigured.snapshotPrivate(), undefined as unknown as string,
        "Private filled property starts as undefined")

    t.equal(plainConfigured.value, 7, "Base.new assigns the plain Base descendant filled property")
    t.equal(configured.baseValue, 10, "Base.new assigns the base filled property")
    t.equal(configured.mixinValue, "configured", "Base.new assigns the mixin filled property")
    t.equal(configured.ownValue, true, "Base.new assigns the consumer filled property")
    t.equal(configured.mixinMethod(), "configured", "Mixin methods see configured filled properties")
})

void [
    t1,
    t2,
    t3,
    t4,
    t5,
    e1,
    e2
]
