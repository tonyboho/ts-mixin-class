import { mixin } from "ts-mixin-class"

export interface PlainContract {
    contractMethod(): string
}

@mixin()
export class SourceClass1<A1> {
    value1: string = "value1"

    passThrough1(a: A1): A1 {
        return a
    }

    method1(): string {
        return this.value1
    }

    static staticMethod1(): string {
        return "staticMethod1"
    }
}

@mixin()
export class SourceClass2<A2> {
    value2: string = "value2"

    passThrough2(a: A2): A2 {
        return a
    }

    method2(): string {
        return this.value2
    }

    static staticMethod2(): string {
        return "staticMethod2"
    }
}

@mixin()
export class ContractMixin implements PlainContract {
    contractValue: string = "contract"

    contractMethod(): string {
        return this.contractValue
    }
}

export class RequiredBase {
    requiredValue: string = "requiredBase"

    requiredMethod(): string {
        return this.requiredValue
    }

    static staticRequired(): string {
        return "staticRequired"
    }
}

// A SPLIT accessor pair (read type ≠ write type), consumed through this package's emitted
// declarations by the declaration-fixture-suite: the generated interface's REAL get/set
// signatures (§1.27) must survive the `.d.ts` round trip with the distinct types intact.
@mixin()
export class Scaled {
    height: number = 10

    get scale(): number {
        return this.height / 10
    }

    set scale(value: number | string) {
        this.height = 10 * (typeof value === "string" ? Number(value) : value)
    }
}

// Exported for the declaration-fixture-suite's manual-`.mix` coverage: program-local
// `.mix` is banned (TS990012), so the manual-application scenarios live on the other
// side of the package boundary — a consumer composing DECLARATION mixins via `.mix`.
@mixin()
export class Named {
    static mixinStatic(): string {
        return "mixinStatic"
    }

    name: string = "Ada"

    label(): string {
        return this.name
    }
}

// A TWO-hop dependency chain (`Top implements Mid`, `Mid implements Bottom`) for the
// declaration-suite manual-`.mix` tests: `.mix` must linearize and apply the transitive
// dependencies, thread `super` through every layer, and the instance type must reach
// `Bottom`'s members through the interface-extends hops.
@mixin()
export class Bottom {
    bottomValue: string = "bottom"

    trace(): string {
        return this.bottomValue
    }
}

@mixin()
export class Mid implements Bottom {
    bottomValue: string = "bottom"

    trace(): string {
        return this.bottomValue
    }

    midTrace(): string {
        return "mid/" + super.trace()
    }
}

@mixin()
export class Top implements Mid {
    bottomValue: string = "bottom"

    trace(): string {
        return this.bottomValue
    }

    midTrace(): string {
        return "mid/" + super.trace()
    }

    topTrace(): string {
        return "top/" + super.midTrace()
    }
}

// A GENERIC required base with a forwarded type parameter, for the declaration-suite
// pin that the published `.mix` signature still enforces the required base (the
// `RuntimeMixinClass` marker erases the forwarded `T`, so the constraint must survive
// through the `mix` signature alone).
export class GenericRequiredBase<T> {
    requiredValue: T

    constructor(requiredValue: T) {
        this.requiredValue = requiredValue
    }

    requiredMethod(): T {
        return this.requiredValue
    }
}

@mixin()
export class GenericRequiredMixin<T> extends GenericRequiredBase<T> {
    genericMixinValue!: T

    genericMixinMethod(): T {
        return this.genericMixinValue
    }
}

@mixin()
export class RequiredMixin extends RequiredBase {
    requiredMixinValue: string = "requiredMixin"

    requiredMixinMethod(): string {
        return super.requiredMethod() + "/" + this.requiredMixinValue
    }

    static staticRequiredMixin(): string {
        return "staticRequiredMixin"
    }
}
