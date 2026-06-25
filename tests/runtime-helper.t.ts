import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import {
    defineMixinClass,
    mixinChain,
    mixinChainLinearized,
    type LinearizationMode,
    type LinearizationPlan,
    type LinearizationSlice
} from "../src/index.js"
import {
    base,
    factory,
    requirements,
    type AnyConstructor,
    type MixinFactory
} from "../src/base.js"
import { mergeC3Linearizations } from "../src/c3-linearization.js"

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

it("linearizes a nontrivial diamond with interleaved requirements", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])
    const D = createNamedMixin("D", [ B, C ])
    const E = createNamedMixin("E", [ A ])
    const F = createNamedMixin("F", [ D, E ])

    class Consumer extends mixinChain(Base, F) {}

    const instance = new Consumer()

    // Two diamonds share A: D pulls in [B, C] (both over A), and F adds E (also over A).
    // C3 delays the shared A past E, so E interleaves between C and A -- a plain DFS would
    // not produce this order, so it pins genuine merge behaviour, not concatenation.
    t.equal(instance.who(), "F>D>B>C>E>A>Base", "Interleaved diamond follows C3 method resolution order")
    t.isInstanceOf(instance, A, "Instance matches the shared transitive mixin A")
    t.isInstanceOf(instance, E, "Instance matches the interleaved mixin E")
    t.isInstanceOf(instance, F, "Instance matches the direct mixin F")
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

it("rejects a nontrivial 3-cycle of pairwise orders", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B")
    const C = createNamedMixin("C")
    const P = createNamedMixin("P", [ A, B ]) // imposes A before B
    const Q = createNamedMixin("Q", [ B, C ]) // imposes B before C
    const R = createNamedMixin("R", [ C, A ]) // imposes C before A

    // Each pair is consistent alone; together they form a cycle A < B < C < A, which no
    // single linearization can satisfy. The conflict is not a direct two-way reversal.
    t.throwsOk(() => {
        createNamedMixin("Z", [ P, Q, R ])
    }, "Cannot linearize mixin classes", "A 3-cycle of pairwise orders is rejected")
})

it("rejects a conflict buried below intermediate mixins", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B")
    const M = createNamedMixin("M", [ A, B ]) // imposes A before B
    const N = createNamedMixin("N", [ B, A ]) // imposes B before A
    const P = createNamedMixin("P", [ M ])
    const Q = createNamedMixin("Q", [ N ])

    // The conflicting A/B order is two hops down, under M and N; the merge only stalls
    // after unwrapping P -> M and Q -> N, so a shallow check would miss it.
    t.throwsOk(() => {
        createNamedMixin("Z", [ P, Q ])
    }, "Cannot linearize mixin classes", "A conflict below intermediate mixins is still rejected")
})

// --- approach (B): precomputed merge-plan replay ---------------------------

it("replays a precomputed merge plan to the same chain as runtime C3 at definition", async (t: Test) => {
    // D and E are built the normal (C3) way; F is built from a precomputed plan over
    // [D, E] instead of a runtime merge. The interleaved-diamond order must be identical.
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])
    const D = createNamedMixin("D", [ B, C ])
    const E = createNamedMixin("E", [ A ])
    const F = createPlannedMixin("F", [ D, E ])

    class Consumer extends mixinChain(Base, F) {}

    const instance = new Consumer()

    t.equal(instance.who(), "F>D>B>C>E>A>Base", "Plan-built mixin reproduces the C3 interleaved order")
    t.isInstanceOf(instance, A, "Plan-built mixin still matches the shared transitive mixin A")
    t.isInstanceOf(instance, E, "Plan-built mixin still matches the interleaved mixin E")
    t.isInstanceOf(instance, F, "Instance matches the plan-built mixin F")
})

it("applies a consumer chain through mixinChainLinearized", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])
    const D = createNamedMixin("D", [ B, C ])
    const E = createNamedMixin("E", [ A ])

    class Consumer extends mixinChainLinearized(Base, [ D, E ], derivePlan([ D, E ])) {}

    t.equal(new Consumer().who(), "D>B>C>E>A>Base", "Plan-applied consumer chain follows C3 order")
})

it("replays nested plans (plan-built mixins depending on plan-built mixins)", async (t: Test) => {
    // Every mixin is plan-built, so each plan replay slices arrays that were THEMSELVES
    // produced by replay -- the inductive case the cross-package optimization relies on.
    const A = createPlannedMixin("A")
    const B = createPlannedMixin("B", [ A ])
    const C = createPlannedMixin("C", [ A ])
    const D = createPlannedMixin("D", [ B, C ])
    const E = createPlannedMixin("E", [ A ])
    const F = createPlannedMixin("F", [ D, E ])

    class Consumer extends mixinChain(Base, F) {}

    t.equal(new Consumer().who(), "F>D>B>C>E>A>Base", "Fully plan-built graph reproduces the C3 order")
})

it("an empty plan reproduces the dependency-free linearization", async (t: Test) => {
    const A = createPlannedMixin("A")

    class Consumer extends mixinChain(Base, A) {}

    t.equal(new Consumer().who(), "A>Base", "A dependency-free mixin needs no merge")
    t.expect(derivePlan([])).toEqual([])
})

it("the \"verify\" mode cross-checks a wrong plan against C3 and throws", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])

    // The correct plan for [B, C] yields B>C>A; this truncated plan drops A, so the replay
    // disagrees with C3 and the "verify" mode must reject it.
    const wrongPlan: LinearizationPlan = [ [ 0, 0, 1 ], [ 1, 0, 1 ] ]

    t.throwsOk(
        () => createMixinWithPlan("D", [ B, C ], wrongPlan, "verify"),
        "differs from the C3 result",
        "verify mode rejects a plan whose replay disagrees with C3"
    )
})

it("the \"replay\" mode trusts a wrong plan verbatim (no cross-check)", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])

    // Same truncated plan, but "replay" mode (production) trusts it: it builds a (wrong) chain
    // without throwing. This pins that verification, not replay, is what "verify" adds.
    const wrongPlan: LinearizationPlan = [ [ 0, 0, 1 ], [ 1, 0, 1 ] ]
    const D                            = createMixinWithPlan("D", [ B, C ], wrongPlan, "replay")

    class Consumer extends mixinChain(Base, D) {}

    t.equal(new Consumer().who(), "D>B>C>Base", "replay mode trusts the unchecked plan verbatim")
})

it("the \"c3\" mode ignores the plan and falls back to C3", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])
    const C = createNamedMixin("C", [ A ])

    // Even a deliberately wrong plan is ignored in "c3" mode: the runtime runs C3 and produces
    // the correct order. The plan is still passed (always emitted), just not used. The escape hatch.
    const wrongPlan: LinearizationPlan = [ [ 0, 0, 1 ], [ 1, 0, 1 ] ]
    const D                            = createMixinWithPlan("D", [ B, C ], wrongPlan, "c3")

    class Consumer extends mixinChain(Base, D) {}

    t.equal(new Consumer().who(), "D>B>C>A>Base", "c3 mode falls back to the correct C3 order")
})

it("a plan referencing a missing source throws in replay/verify modes", async (t: Test) => {
    const A = createNamedMixin("A")
    const B = createNamedMixin("B", [ A ])

    // Source index 5 does not exist among [L[A], L[B], [A, B]]; this is a malformed plan
    // (a compiler bug), so replaying it fails loudly instead of producing garbage.
    const badPlan: LinearizationPlan = [ [ 5, 0, 1 ] ]

    t.throwsOk(
        () => createMixinWithPlan("Bad", [ A, B ], badPlan, "replay"),
        "missing source",
        "A plan pointing at a nonexistent source is rejected"
    )
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

// Like createNamedMixin, but registers the mixin with a precomputed merge plan (the
// compile-time artifact) instead of letting the runtime merge its requirements.
function createPlannedMixin(
    name: string,
    requirements: ReturnType<typeof defineMixinClass>[] = []
): ReturnType<typeof defineMixinClass> {
    return createMixinWithPlan(name, requirements, derivePlan(requirements), "verify")
}

function createMixinWithPlan(
    name: string,
    requirements: ReturnType<typeof defineMixinClass>[],
    plan: LinearizationPlan,
    mode: LinearizationMode
): ReturnType<typeof defineMixinClass> {
    const factory = ((base: AnyConstructor<NamedInstance>) => {
        return class extends base {
            who(): string {
                return `${name}>${super.who()}`
            }
        }
    }) as unknown as MixinFactory

    return defineMixinClass(name, factory, requirements, Object, plan, mode)
}

// Compile-time plan derivation, mirrored from bench/c3 (`derivePlans`): run C3 over a
// requirement list's merge sources and attribute every output element to a source cursor,
// coalescing contiguous same-source runs into slices. The merge sources are each
// requirement's full linearization, then the direct requirement list -- the same inputs
// the runtime replays against (RuntimeMixinClass.requirementMergeSources).
type AnyMixin = ReturnType<typeof defineMixinClass>

function derivePlan(deps: readonly AnyMixin[]): LinearizationPlan {
    if (deps.length === 0) {
        return []
    }

    const sources                            = mergeSources(deps)
    const merged                             = mergeC3Linearizations(sources)
    const cursors                            = sources.map(() => 0)
    const plan: [ number, number, number ][] = []

    for (const element of merged) {
        const pick = sources.findIndex((source, index) => source[cursors[index]!] === element)
        const last = plan[plan.length - 1]

        if (last !== undefined && last[0] === pick && last[1] + last[2] === cursors[pick]!) {
            last[2]++
        } else {
            plan.push([ pick, cursors[pick]!, 1 ])
        }

        for (let index = 0; index < sources.length; index++) {
            if (sources[index]![cursors[index]!] === element) {
                cursors[index]!++
            }
        }
    }

    return plan as LinearizationSlice[]
}

function mergeSources(deps: readonly AnyMixin[]): AnyMixin[][] {
    return [ ...deps.map((dep) => linearizeMixin(dep)), [ ...deps ] ]
}

// L[m] = [m, ...C3-merge(L[deps], deps)], recomputed from the public `requirements` symbol
// independently of how m was registered -- so a plan derived here is correct whether the
// mixin was built by C3 or by replay.
function linearizeMixin(mixin: AnyMixin, cache: Map<AnyMixin, AnyMixin[]> = new Map()): AnyMixin[] {
    const cached = cache.get(mixin)

    if (cached !== undefined) {
        return cached
    }

    const deps   = [ ...(mixin[requirements] as readonly AnyMixin[]) ]
    const merged = deps.length === 0
        ? []
        : mergeC3Linearizations([ ...deps.map((dep) => linearizeMixin(dep, cache)), deps ])
    const result = [ mixin, ...merged ]

    cache.set(mixin, result)

    return result
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
