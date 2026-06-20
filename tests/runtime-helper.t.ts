import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import {
    defineMixinClass,
    mixinChain
} from "../src/index.js"
import {
    base,
    factory,
    requirements,
    type AnyConstructor,
    type MixinFactory
} from "../src/base.js"

type NamedInstance = {
    who(): string
}

class Base {
    who(): string {
        return "Base"
    }
}

it("linearizes mixin requirements with C3 order", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])
    const D = createNamedMixin("D", [ B, C ])

    class Consumer extends mixinChain(Base, D) {}

    const instance = new Consumer()

    t.equal(instance.who(), "D>B>C>A>Base", "Diamond dependencies follow C3 method resolution order")
    t.isInstanceOf(instance, A, "Instance matches transitive mixin A")
    t.isInstanceOf(instance, B, "Instance matches transitive mixin B")
    t.isInstanceOf(instance, C, "Instance matches transitive mixin C")
    t.isInstanceOf(instance, D, "Instance matches direct mixin D")
})

it("caches mixin applications for the same base", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])

    t.equal(mixinChain(Base, B), mixinChain(Base, B), "Repeated chain creation returns the cached class")
})

it("applies a mixin through the static mix property", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])
    const D = createNamedMixin("D", [ B, C ])

    class Consumer extends D.mix(Base) {}

    const instance = new Consumer()

    t.equal(instance.who(), "D>B>C>A>Base", "Manual mix application follows C3 order")
    t.isInstanceOf(instance, A, "Manual mix application matches transitive mixin A")
    t.isInstanceOf(instance, B, "Manual mix application matches transitive mixin B")
    t.isInstanceOf(instance, C, "Manual mix application matches transitive mixin C")
    t.isInstanceOf(instance, D, "Manual mix application matches direct mixin D")
    t.equal(D.mix(Base), D.mix(Base), "Manual mix applications are cached for the same base")
})

it("exposes runtime metadata through exported symbols", async (t: Test) => {
    class RequiredBase {
    }

    const A             = createNamedMixin("A")
    const B             = createNamedMixin("B", [ A ])
    const RequiredMixin = defineMixinClass("RequiredMixin", ((base: AnyConstructor<RequiredBase>) => {
        return class extends base {}
    }) as unknown as MixinFactory, [], RequiredBase)

    t.equal(typeof A[factory], "function", "Mixin factory is available through the exported symbol")
    t.expect(B[requirements]).toEqual([ A ])
    t.equal(RequiredMixin[base], RequiredBase, "Required base is available through the exported symbol")
    t.false("$mixin" in A, "String metadata property is not exposed on the runtime class")
    t.false("$requirements" in A, "String requirements property is not exposed on the runtime class")
    t.false("$requiredBase" in RequiredMixin, "String required-base property is not exposed on the runtime class")
})

it("reuses canonical requirement classes while defining sibling mixins", async (t: Test) => {
    const aBases: AnyConstructor[] = []
    const bBases: AnyConstructor[] = []
    const cBases: AnyConstructor[] = []

    const A = createTrackedMixin("A", aBases)

    createTrackedMixin("B", bBases, [ A ])
    createTrackedMixin("C", cBases, [ A ])

    t.equal(aBases.length, 1, "Requirement factory is not re-applied for each dependent mixin")
    t.equal(aBases[0], Object, "Standalone mixin is first applied to Object")
    t.equal(bBases[0], A, "First dependent mixin receives the canonical requirement class")
    t.equal(cBases[0], A, "Second dependent mixin reuses the same canonical requirement class")
})

it("reuses a canonical requirement chain for deeper dependents", async (t: Test) => {
    const aBases: AnyConstructor[] = []
    const bBases: AnyConstructor[] = []
    const cBases: AnyConstructor[] = []

    const A = createTrackedMixin("A", aBases)
    const B = createTrackedMixin("B", bBases, [ A ])

    createTrackedMixin("C", cBases, [ B ])

    t.equal(aBases.length, 1, "Bottom requirement is not rebuilt for the deeper chain")
    t.equal(bBases.length, 1, "Top requirement is not rebuilt for the deeper chain")
    t.equal(bBases[0], A, "Top requirement was built on the canonical bottom class")
    t.equal(cBases[0], B, "Deeper dependent receives the canonical top requirement class")
})

it("applies mixins with a required base to consumer-provided descendants", async (t: Test) => {
    class RequiredBase {
        who(): string {
            return "RequiredBase"
        }
    }

    class RealBase extends RequiredBase {
        override who(): string {
            return "RealBase"
        }
    }

    const RequiredMixin = defineMixinClass("RequiredMixin", ((base: AnyConstructor<RequiredBase>) => {
        return class extends base {
            override who(): string {
                return `RequiredMixin>${super.who()}`
            }
        }
    }) as unknown as MixinFactory, [], RequiredBase)

    class Consumer extends mixinChain(RealBase, RequiredMixin) {}

    const instance = new Consumer()

    t.equal(instance.who(), "RequiredMixin>RealBase", "Mixin super calls the consumer-provided descendant base")
    t.isInstanceOf(instance, RealBase, "Consumer still inherits from the concrete base")
    t.isInstanceOf(instance, RequiredBase, "Consumer satisfies the required base")
    t.isInstanceOf(instance, RequiredMixin, "Consumer matches the required-base mixin")
    t.equal(new RequiredMixin().who(), "RequiredMixin>RequiredBase", "Canonical mixin class uses the required base")
})

it("rejects applying a required-base mixin to an unrelated base", async (t: Test) => {
    class RequiredBase {}
    class UnrelatedBase {}

    const RequiredMixin = defineMixinClass("RequiredMixin", ((base: AnyConstructor<RequiredBase>) => {
        return class extends base {}
    }) as unknown as MixinFactory, [], RequiredBase)

    t.throwsOk(() => {
        mixinChain(UnrelatedBase, RequiredMixin)
    }, "requires base", "Runtime rejects an unrelated base")
})

it("rejects inconsistent C3 requirements", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B")
    const X = createNamedMixin("X", [ A, B ])
    const Y = createNamedMixin("Y", [ B, A ])

    t.throwsOk(() => {
        createNamedMixin("Z", [ X, Y ])
    }, "Cannot linearize mixin classes", "Inconsistent order is rejected")
})

function createNamedMixin(
    name: string,
    requirements: ReturnType<typeof defineMixinClass>[] = []
): ReturnType<typeof defineMixinClass> {
    const factory = ((base: AnyConstructor<NamedInstance>) => {
        return class extends base {
            who(): string {
                return `${name}>${super.who()}`
            }
        }
    }) as unknown as MixinFactory

    return defineMixinClass(name, factory, requirements)
}

function createTrackedMixin(
    name: string,
    bases: AnyConstructor[],
    requirements: ReturnType<typeof defineMixinClass>[] = []
): ReturnType<typeof defineMixinClass> {
    const factory = ((base: AnyConstructor) => {
        bases.push(base)
        return class extends base {}
    }) as unknown as MixinFactory

    return defineMixinClass(name, factory, requirements)
}
