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
