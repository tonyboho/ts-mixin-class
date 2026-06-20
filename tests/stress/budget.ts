// A time + iteration budget so each stress test self-tunes to roughly a second
// regardless of machine speed: it keeps iterating until either the time budget
// elapses or the iteration cap is reached. On a fast machine that means ~500
// iterations; on a slow one it might be ~100 — exactly the "100 vs 500 depending
// on how long it takes" behaviour we want, while staying under ~1s per test.

export type StressBudget = {
    durationMs    : number,
    maxIterations : number
}

export const defaultStressBudget: StressBudget = {
    durationMs    : 600,
    maxIterations : 500
}

// Env-tunable budget so a stress test can be pushed far harder when chasing a flake:
//   MIXIN_STRESS_DURATION_MS    - time budget per test (ms)
//   MIXIN_STRESS_MAX_ITERATIONS - iteration cap
// e.g. `MIXIN_STRESS_DURATION_MS=5000 MIXIN_STRESS_MAX_ITERATIONS=100000 pnpm test`.
export function resolveStressBudget(base: StressBudget = defaultStressBudget): StressBudget {
    const readPositiveInt = (name: string, fallback: number): number => {
        const raw = process.env[name]

        if (raw === undefined || raw.trim() === "") {
            return fallback
        }

        const parsed = Number.parseInt(raw, 10)

        if (Number.isNaN(parsed) || parsed <= 0) {
            throw new Error(`Invalid ${name}: ${JSON.stringify(raw)} must be a positive integer.`)
        }

        return parsed
    }

    return {
        durationMs    : readPositiveInt("MIXIN_STRESS_DURATION_MS", base.durationMs),
        maxIterations : readPositiveInt("MIXIN_STRESS_MAX_ITERATIONS", base.maxIterations)
    }
}

// Exhaustive mode walks EVERY enumerated AST site exactly once instead of random sampling
// within a budget. The site set comes from the parse tree, so it is finite — this is
// deterministic and reproducible (random sampling can hide a rare offending site for many
// runs, which is exactly how a real crash slipped through as an intermittent flake).
//
// It is the DEFAULT. Set `MIXIN_STRESS_EXHAUSTIVE=0` (or `false`) to fall back to the older
// random+budget mode (e.g. for a quick local smoke run).
export function stressExhaustive(): boolean {
    const raw = process.env.MIXIN_STRESS_EXHAUSTIVE

    if (raw === undefined || raw.trim() === "") {
        return true
    }

    return raw.trim() !== "0" && raw.trim().toLowerCase() !== "false"
}

// Drives a stress test over a finite item set (e.g. every enumerated AST site, or every root
// file): exhaustively walk each item once (the default), or random-sample within the budget.
// `stop` short-circuits on the first failure so a found bug halts immediately.
export async function runStressAsync<Item>(
    items: readonly Item[],
    pickRandom: () => Item,
    probe: (item: Item) => Promise<void>,
    stop: () => boolean = () => false
): Promise<number> {
    if (stressExhaustive()) {
        let count = 0

        for (const item of items) {
            if (stop()) {
                break
            }

            await probe(item)
            count++
        }

        return count
    }

    return runWithinBudgetAsync(async () => {
        if (!stop()) {
            await probe(pickRandom())
        }
    }, resolveStressBudget())
}

export function runStress<Item>(
    items: readonly Item[],
    pickRandom: () => Item,
    probe: (item: Item) => void,
    stop: () => boolean = () => false
): number {
    if (stressExhaustive()) {
        let count = 0

        for (const item of items) {
            if (stop()) {
                break
            }

            probe(item)
            count++
        }

        return count
    }

    return runWithinBudget(() => {
        if (!stop()) {
            probe(pickRandom())
        }
    }, resolveStressBudget())
}

export function runWithinBudget(
    iterate: (iteration: number) => void,
    budget: StressBudget = defaultStressBudget
): number {
    const startedAt = Date.now()
    let iteration   = 0

    while (iteration < budget.maxIterations && Date.now() - startedAt < budget.durationMs) {
        iterate(iteration)
        iteration++
    }

    return iteration
}

export async function runWithinBudgetAsync(
    iterate: (iteration: number) => Promise<void>,
    budget: StressBudget = defaultStressBudget
): Promise<number> {
    const startedAt = Date.now()
    let iteration   = 0

    while (iteration < budget.maxIterations && Date.now() - startedAt < budget.durationMs) {
        await iterate(iteration)
        iteration++
    }

    return iteration
}
