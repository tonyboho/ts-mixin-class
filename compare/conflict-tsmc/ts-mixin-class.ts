import { mixin } from "ts-mixin-class"

@mixin()
class A {
    a(): string {
        return "A"
    }
}

@mixin()
class B {
    b(): string {
        return "B"
    }
}

// X fixes the order A-before-B
@mixin()
class X implements A, B {}

// Y fixes the opposite order B-before-A
@mixin()
class Y implements B, A {}

// Z asks for both X and Y — an impossible order (A before B AND B before A).
// ts-mixin-class rejects this at COMPILE TIME instead of silently picking one.
class Z implements X, Y {}
