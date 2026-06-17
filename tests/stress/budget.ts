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
