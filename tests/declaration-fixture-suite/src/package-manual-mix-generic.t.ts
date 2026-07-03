import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import {
    GenericRequiredBase,
    GenericRequiredMixin,
    SourceClass1
} from "ts-mixin-class-fixture-suite/mixins"

// §5 boundaries (relocated from the fixture-suite when program-local `.mix` became
// TS990012), on the GENERIC side of the published `.mix` signature: explicit type
// arguments (`Mixin.mix<T, typeof Base>(Base)`), the base-type-argument requirement
// (§5.3), and the required-base constraint of a generic mixin with a forwarded type
// parameter — both its compile-time rejection and the runtime guard behind it.
class ManualBase {
    baseValue: number

    constructor(baseValue: number) {
        this.baseValue = baseValue
    }
}

class GenericManualBox extends SourceClass1.mix<string, typeof ManualBase>(ManualBase) {
}

const genericBox = new GenericManualBox(10)

genericBox.value1 = "generic"

const t1: string = genericBox.passThrough1("x")
const t2: number = genericBox.baseValue
const t3: string = GenericManualBox.staticMethod1()

// @ts-expect-error Generic mix parameters must include the base type when mixin type arguments are explicit.
SourceClass1.mix<string>(ManualBase)

// @ts-expect-error SourceClass1 is applied as SourceClass1<string>.
genericBox.passThrough1(10)

// @ts-expect-error ManualBase constructor still requires a number.
new GenericManualBox("bad")

it("manually applies a generic declaration mixin with explicit type arguments", async (t: Test) => {
    t.equal(genericBox.passThrough1("x"), "x", "the explicit mixin type argument is applied")
    t.equal(genericBox.baseValue, 10, "the manual base constructor field is preserved")
    t.equal(GenericManualBox.staticMethod1(), "staticMethod1", "mixin statics survive the manual application")
    t.isInstanceOf(genericBox, ManualBase, "instanceof matches the base")
    t.isInstanceOf(genericBox, SourceClass1, "instanceof matches the mixin")
})

class SatisfiedBase extends GenericRequiredBase<string> {
}

// The mixin's own `T` appears only in the base CONSTRAINT, which TypeScript does not
// infer from — a generic mixin's `.mix` takes explicit type arguments (§5.3 flip side).
class GenericRequiredConsumer extends GenericRequiredMixin.mix<string, typeof SatisfiedBase>(SatisfiedBase) {
}

class Unrelated {
}

it("the published .mix signature of a generic mixin still enforces its required base", async (t: Test) => {
    const good = new GenericRequiredConsumer("seed")

    t.equal(good.requiredMethod(), "seed", "a satisfying base composes and forwards the type parameter")

    good.genericMixinValue = "value"

    const forwarded: string = good.genericMixinMethod()

    t.equal(forwarded, "value", "the mixin's own generic member is typed by the base's argument")

    t.throwsOk(
        () => {
            // The compile-time rejection (the `mix` signature's `AnyConstructor<RequiredBase>`
            // constraint) and the runtime guard behind it, pinned together.
            // @ts-expect-error an unrelated base does not satisfy GenericRequiredBase.
            GenericRequiredMixin.mix(Unrelated)
        },
        "requires base",
        "the runtime guard backs the rejected application"
    )
})

void [ t1, t2, t3 ]
