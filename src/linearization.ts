import { C3LinearizationError, mergeC3Linearizations } from "./c3-linearization.js"
import type { LinearizationSlice } from "./runtime.js"
import {
    DependencyLinearizationError,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"

export function linearizeDependencies(
    dependencyKeys: string[],
    context: FileMixinContext
): ResolvedMixinRef[] {
    // Per-mixin linearizations come from the program-wide cache, so each mixin's
    // linearization is computed once instead of per consumer. Only the consumer's
    // own merge (below) is recomputed each call.
    return linearizeDependencyKeys(dependencyKeys, context, context.linearizationCache).map((key) => {
        return context.byKey.get(key)!
    })
}

// A compile-time merge plan (approach B): the C3 result of `dependencyKeys` expressed as
// contiguous slices `[source, offset, length]` over the merge inputs
// `[ L[d1], ..., L[dk], [d1..dk] ]`. The runtime reconstructs the linearization by copying
// these slices out of the dependencies' already-materialized linearizations
// (RuntimeMixinClass.requirementMergeSources) instead of re-running C3. Offsets are
// positional, so a plan derived here over keys replays identically over runtime values --
// the inputs are built in the same order in both places. Throws DependencyLinearizationError
// on a conflict (no plan exists), exactly like `linearizeDependencies`.
//
// The slice IS the runtime's wire shape: this module derives exactly what the published
// runtime replays, so the type is shared with `runtime.ts` rather than re-declared.
export type LinearizationPlanSlice = LinearizationSlice

export function deriveLinearizationPlan(
    dependencyKeys: string[],
    context: FileMixinContext
): LinearizationPlanSlice[] {
    if (dependencyKeys.length === 0) {
        return []
    }

    const cache                              = context.linearizationCache
    const sources                            = [
        ...dependencyKeys.map((key) => linearizeDependencyKey(key, context, cache)),
        [ ...dependencyKeys ]
    ]
    const merged                             = mergeDependencyLinearizations(sources)
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

    return plan
}

function linearizeDependencyKeys(
    dependencyKeys: string[],
    context: FileMixinContext,
    cache: Map<string, string[]> = new Map()
): string[] {
    if (dependencyKeys.length === 0) {
        return []
    }

    return mergeDependencyLinearizations([
        ...dependencyKeys.map((key) => linearizeDependencyKey(key, context, cache)),
        [ ...dependencyKeys ]
    ])
}

function linearizeDependencyKey(
    key: string,
    context: FileMixinContext,
    cache: Map<string, string[]>
): string[] {
    const cached = cache.get(key)

    if (cached !== undefined) {
        return cached
    }

    const ref = context.byKey.get(key)

    if (ref === undefined) {
        return [ key ]
    }

    const linearized = [
        key,
        ...linearizeDependencyKeys(ref.dependencies, context, cache)
    ]

    cache.set(key, linearized)

    return linearized
}

function mergeDependencyLinearizations(sequences: string[][]): string[] {
    try {
        return mergeC3Linearizations(sequences)
    }
    catch (error) {
        if (error instanceof C3LinearizationError) {
            throw new DependencyLinearizationError(error.pendingSequences)
        }

        throw error
    }
}
