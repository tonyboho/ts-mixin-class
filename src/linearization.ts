import { C3LinearizationError, mergeC3Linearizations } from "./c3-linearization.js"
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
