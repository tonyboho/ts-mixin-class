import { unsafeUniformIntDistribution, xoroshiro128plus } from "pure-rand"
import type { RandomGenerator } from "pure-rand"

// A small seedable RNG wrapper over pure-rand. Every stress test derives all of
// its randomness from one master seed so a failing run is reproducible: the seed
// is logged (and printed into the failing assertion), and re-running with
// `MIXIN_STRESS_SEED=<seed>` replays the exact same sequence of choices.

export class SeededRandom {
    private generator : RandomGenerator

    constructor(readonly seed: number) {
        this.generator = xoroshiro128plus(seed)
    }

    // Inclusive on both ends.
    int(minInclusive: number, maxInclusive: number): number {
        if (maxInclusive < minInclusive) {
            return minInclusive
        }

        return unsafeUniformIntDistribution(minInclusive, maxInclusive, this.generator)
    }

    below(maxExclusive: number): number {
        return maxExclusive <= 0 ? 0 : this.int(0, maxExclusive - 1)
    }

    bool(): boolean {
        return this.int(0, 1) === 1
    }

    pick<Item>(items: readonly Item[]): Item {
        if (items.length === 0) {
            throw new Error("Cannot pick from an empty array.")
        }

        return items[this.below(items.length)]
    }
}

// 0 .. 2^31 - 1, so seeds print as plain positive integers that are easy to copy
// back into MIXIN_STRESS_SEED.
export function randomSeed(): number {
    return Math.floor(Math.random() * 0x7fffffff)
}

export function resolveSeed(envName = "MIXIN_STRESS_SEED"): number {
    const fromEnvironment = process.env[envName]

    if (fromEnvironment !== undefined && fromEnvironment.trim() !== "") {
        const parsed = Number.parseInt(fromEnvironment, 10)

        if (Number.isNaN(parsed)) {
            throw new Error(`Invalid ${envName}: ${JSON.stringify(fromEnvironment)} is not an integer.`)
        }

        return parsed
    }

    return randomSeed()
}
