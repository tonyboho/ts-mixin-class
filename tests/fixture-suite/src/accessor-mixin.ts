import { mixin } from "ts-mixin-class"

// An accessor-carrying mixin in its own module, consumed across files by
// `consumer-imported-accessor.t.ts` (§10 × §1.8: cross-file resolution of accessor members).
@mixin()
export class Measured {
    width: number  = 0
    height: number = 0

    get area(): number {
        return this.width * this.height
    }

    get ratio(): number {
        return this.height === 0 ? 0 : this.width / this.height
    }

    set ratio(value: number) {
        this.width = this.height * value
    }
}
