import { Base, mixin } from "ts-mixin-class"

// The declaring module behind `construction-barrel.ts` (an `export *` barrel): a
// construction base with a REQUIRED computed key, and a construction mixin. Consumers
// import both ONLY through the barrel (§10.26).

export const rankKey: unique symbol = Symbol("rankKey")

export class BarrelBase extends Base {
    public baseValue!: string
    public [rankKey]!: number
}

@mixin()
export class BarrelTagged extends Base {
    public tag?: string = ""
}
