// Exploration probe for TODO limitation 1 ("Mixin members cannot be `private`, `protected`,
// `#private`, or `abstract`"): which member modifiers COULD the transform support, per plane.
// Each section mirrors the transform's actual generated shapes (omitting interface + factory
// class for EMIT, claiming cast for SOURCE VIEW). Self-verifying: compiling this file IS the
// type-level check (incl. the `@ts-expect-error` assertions), evaluating it exercises the
// runtime chains. Findings are written up in TODO.md limitation 1.

type AnyConstructor<T = object> = new (...args: any[]) => T

// ============================================================================
// A. #private (ECMAScript private) under the EMIT shape: the mixin's public
//    surface is an interface OMITTING the # member; the factory class declares
//    and uses it; the consumer inherits through the interface.
// ============================================================================

interface TaggedA {
    visible(): number
}

const __TaggedA$mixin = function (base: AnyConstructor) {
    class __TaggedA$class extends base {
        #secret : number = 42

        visible(): number {
            return this.#secret
        }
    }

    return __TaggedA$class
}

const TaggedA = __TaggedA$mixin(Object) as unknown as (new () => TaggedA)

interface __UserA$base extends TaggedA {}
class __UserA$base extends (__TaggedA$mixin(Object) as unknown as AnyConstructor & Omit<typeof TaggedA, "prototype" | "new">) {}

class UserA extends __UserA$base implements TaggedA {}

const userA      = new UserA()
const a1: number = userA.visible()
void a1
void TaggedA

// ============================================================================
// B. #private under the SOURCE-VIEW shape: the mixin stays a REAL class with
//    the # member; the consumer extends a cast CLAIMING that class's instance
//    type and `implements` the class type directly.
// ============================================================================

class TaggedB {
    #secret : number = 42

    visible(): number {
        return this.#secret
    }
}

class UserB extends (Object as unknown as AnyConstructor<TaggedB> & Omit<typeof TaggedB, "prototype" | "new">) implements TaggedB {}

// Type-only plane: the source-view cast never executes (runtime comes from emit).
function typeOnlyB(userB: UserB): number {
    return userB.visible()
}
void typeOnlyB

// ============================================================================
// C. TS `private` / `protected` under the SOURCE-VIEW shape: same claiming
//    cast — does `implements` accept a class with private/protected members
//    when the heritage CLAIMS the class type?
// ============================================================================

class TaggedC {
    protected shared : number = 1
    private own      : number = 2

    visible(): number {
        return this.shared + this.own
    }
}

class UserC extends (Object as unknown as AnyConstructor<TaggedC> & Omit<typeof TaggedC, "prototype" | "new">) implements TaggedC {}

// Type-only plane, as above.
function typeOnlyC(userC: UserC): number {
    // @ts-expect-error protected stays inaccessible from outside
    userC.shared = 5

    return userC.visible()
}
void typeOnlyC

// ============================================================================
// D. TS `private`/`protected` under the EMIT shape with an OMITTING interface:
//    the interface just leaves the member out (runtime property exists,
//    type-invisible). The factory class keeps the modifier.
// ============================================================================

interface TaggedD {
    visible(): number
}

const __TaggedD$mixin = function (base: AnyConstructor) {
    class __TaggedD$class extends base {
        protected shared : number = 1

        visible(): number {
            return this.shared
        }
    }

    return __TaggedD$class
}

const TaggedD = __TaggedD$mixin(Object) as unknown as (new () => TaggedD)

interface __UserD$base extends TaggedD {}
class __UserD$base extends (__TaggedD$mixin(Object) as unknown as AnyConstructor & Omit<typeof TaggedD, "prototype" | "new">) {}

class UserD extends __UserD$base implements TaggedD {
    // A consumer redeclaring the invisible name as its OWN public member: silently
    // collides at runtime with the mixin's protected property. Type system cannot see it.
    shared : string = "collision"
}

void new UserD()
void TaggedD

// ============================================================================
// E. interface extends a class with # / protected members: allowed? nominal?
// ============================================================================

interface SurfaceB extends TaggedB {}
interface SurfaceC extends TaggedC {}

// @ts-expect-error an unrelated class cannot implement an interface that inherited a # member
class FakeB implements SurfaceB {
    visible(): number {
        return 0
    }
}

// @ts-expect-error the protected/private-carrying interface is nominal the same way
class FakeC implements SurfaceC {
    visible(): number {
        return 0
    }
}

void FakeB
void FakeC

// ============================================================================
// F. abstract: a generated intermediate ABSTRACT class re-declaring the
//    mixin's abstract member forces the concrete consumer to implement it,
//    even when the runtime base below is a cast.
// ============================================================================

interface RendererF {
    paint(): void,
    render(): void
}

const __RendererF$mixin = function (base: AnyConstructor) {
    abstract class __RendererF$class extends base {
        abstract paint(): void

        render(): void {
            this.paint()
        }
    }

    return __RendererF$class
}

// The cast carries the mixin's FULL instance surface (paint + render, like our
// consumer casts do); the generated $base re-declares `abstract paint()` on top, so
// abstractness survives the cast and forces the concrete consumer to implement it.
abstract class __UserF$base extends (__RendererF$mixin(Object) as unknown as AnyConstructor<RendererF>) {
    abstract paint(): void
}

class UserF extends __UserF$base implements RendererF {
    paint(): void {}
}

// @ts-expect-error a consumer that does NOT implement the abstract member is rejected
class LazyF extends __UserF$base implements RendererF {}

void new UserF().render()
void LazyF
