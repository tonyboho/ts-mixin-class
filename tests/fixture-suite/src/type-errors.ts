import { RequiredMixin } from "./mixins.js"
import { mixin } from "ts-mixin-class"

@mixin()
class ContractSourceClass1<A1> {
    passThrough1(a: A1): A1 {
        return a
    }
}

@mixin()
class ContractSourceClass2<A2> {
    method2(): A2 {
        throw new Error("not implemented")
    }
}

class BadGenericConsumer implements ContractSourceClass1<string> {
    // @ts-expect-error ContractSourceClass1<string> requires passThrough1(a: string): string.
    passThrough1(a: number): number {
        return a
    }
}

class BadOverrideConsumer implements ContractSourceClass2<boolean> {
    // @ts-expect-error ContractSourceClass2<boolean> requires method2(): boolean.
    method2(): number {
        return 1
    }
}

class UnrelatedRequiredConsumerBase {
}

// @ts-expect-error RequiredMixin requires a RequiredBase-compatible consumer base.
class BadRequiredConsumer extends UnrelatedRequiredConsumerBase implements RequiredMixin {
}

@mixin()
class LinearizationA {
}

@mixin()
class LinearizationB {
}

// LinearizationX and LinearizationY are each individually consistent (so neither mixin
// errors); only a consumer that applies BOTH forces LinearizationA and LinearizationB into
// opposite orders, which has no C3 linearization. (A mixin whose OWN dependencies conflict is
// covered by nontrivial-diamond-linearization.t.ts and source-transform-cross-package-*; it
// can't live in this build-must-pass corpus because its emit-mode error cannot be suppressed
// at the declaration -- the mixin decorator is stripped and the file reprinted.)
@mixin()
class LinearizationX implements LinearizationA, LinearizationB {
}

@mixin()
class LinearizationY implements LinearizationB, LinearizationA {
}

// @ts-expect-error LinearizationX and LinearizationY have inconsistent C3 requirements together.
class BadLinearizationConsumer implements LinearizationX, LinearizationY {
}

@mixin()
class StaticCollisionLeftMixin {
    static shared: string = "left"
}

@mixin()
class StaticCollisionRightMixin {
    static shared: number = 1
}

// @ts-expect-error StaticCollisionLeftMixin and StaticCollisionRightMixin have incompatible static members.
class BadStaticCollisionConsumer implements StaticCollisionLeftMixin, StaticCollisionRightMixin {
}

void [
    BadGenericConsumer,
    BadOverrideConsumer,
    BadRequiredConsumer,
    BadLinearizationConsumer,
    BadStaticCollisionConsumer
]
