// =============================================================================
// TEMPORARY WORKAROUND for https://github.com/microsoft/TypeScript/issues/63555
//
// Generating the full transitive mixin heritage graph triggers pathological
// checker behavior. This module shrinks the generated heritage by dropping
// simple local, non-generic mixin entries that are already reachable through
// another direct mixin. Runtime dependency metadata is unaffected.
//
// To revert once TypeScript fixes the bug: delete this file and, at each call
// site below, use the raw heritage list instead of the reduced one:
//   - src/consumer-expand.ts   (3 calls)
//   - src/mixin-expand.ts      (2 calls)
//
// The reachability memo lives here (a per-file WeakMap) on purpose, so the
// workaround stays entirely self-contained and leaves the core types clean.
// =============================================================================

import type * as ts from "typescript"
import type { FileMixinContext } from "./model.js"
import type { TypeScript } from "./util.js"

// Per-file cache of transitive dependency reachability (registry key -> all keys
// reachable through dependencies). reduceTransitiveMixinHeritageTypes runs an
// O(d^2) pairwise check and is called once per consumer and per mixin, so this
// memo turns each pair into an O(1) set lookup instead of a fresh graph walk.
// Keyed by the FileMixinContext, so all expansions in one file share it.
const reachabilityCacheByContext = new WeakMap<FileMixinContext, Map<string, Set<string>>>()

export function reduceTransitiveMixinHeritageTypes(
    tsInstance: TypeScript,
    context: FileMixinContext,
    heritageTypes: ts.ExpressionWithTypeArguments[]
): ts.ExpressionWithTypeArguments[] {
    const direct = heritageTypes.map((heritageType) => {
        if (!tsInstance.isIdentifier(heritageType.expression) || heritageType.typeArguments !== undefined) {
            return { heritageType, ref: undefined }
        }

        return {
            heritageType,
            ref : context.byLocalName.get(heritageType.expression.text)
        }
    })

    return direct
        .filter((entry) => {
            const ref = entry.ref

            if (ref === undefined) {
                return true
            }

            return !direct.some((other) => {
                return other !== entry &&
                    other.ref !== undefined &&
                    other.heritageType.typeArguments === undefined &&
                    reachableMixinKeys(context, other.ref.key).has(ref.key)
            })
        })
        .map((entry) => entry.heritageType)
}

// All registry keys reachable through `startKey`'s transitive dependencies,
// memoized per key on the file's reachability cache.
function reachableMixinKeys(context: FileMixinContext, startKey: string): Set<string> {
    return collectReachableMixinKeys(context, startKey, new Set())
}

function collectReachableMixinKeys(
    context: FileMixinContext,
    startKey: string,
    visiting: Set<string>
): Set<string> {
    const cache  = reachabilityCacheFor(context)
    const cached = cache.get(startKey)

    if (cached !== undefined) {
        return cached
    }

    // A back-edge means a dependency cycle (rejected elsewhere by C3). Return an
    // empty, uncached set for the revisited node to break the recursion.
    if (visiting.has(startKey)) {
        return new Set()
    }

    visiting.add(startKey)

    const reachable = new Set<string>()
    const ref       = context.byKey.get(startKey)

    if (ref !== undefined) {
        for (const dependencyKey of ref.dependencies) {
            reachable.add(dependencyKey)

            for (const transitiveKey of collectReachableMixinKeys(context, dependencyKey, visiting)) {
                reachable.add(transitiveKey)
            }
        }
    }

    visiting.delete(startKey)
    cache.set(startKey, reachable)

    return reachable
}

function reachabilityCacheFor(context: FileMixinContext): Map<string, Set<string>> {
    let cache = reachabilityCacheByContext.get(context)

    if (cache === undefined) {
        cache = new Map<string, Set<string>>()
        reachabilityCacheByContext.set(context, cache)
    }

    return cache
}
