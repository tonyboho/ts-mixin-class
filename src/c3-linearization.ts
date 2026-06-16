export class C3LinearizationError<T> extends Error {
    constructor(readonly pendingSequences: readonly T[][]) {
        super("Cannot linearize sequences with the C3 algorithm")
    }
}

type PendingSequence<T> = {
    sequence : T[],
    offset   : number
}

type Candidate<T> =
    | { found: true, value: T }
    | { found: false }

export function mergeC3Linearizations<T>(sequences: readonly (readonly T[])[]): T[] {
    const result: T[] = []
    const pending = sequences
        .map((sequence) => [ ...new Set(sequence) ])
        .filter((sequence) => sequence.length > 0)
        .map((sequence): PendingSequence<T> => {
            return {
                sequence,
                offset : 0
            }
        })
    const tailCounts = buildTailCounts(pending)

    while (pending.length > 0) {
        const candidate = findC3Candidate(pending, tailCounts)

        if (!candidate.found) {
            throw new C3LinearizationError(remainingSequences(pending))
        }

        result.push(candidate.value)
        consumeC3Candidate(pending, candidate.value, tailCounts)
    }

    return result
}

function buildTailCounts<T>(pending: readonly PendingSequence<T>[]): Map<T, number> {
    const tailCounts = new Map<T, number>()

    for (const pendingSequence of pending) {
        for (let index = pendingSequence.offset + 1; index < pendingSequence.sequence.length; index++) {
            incrementTailCount(tailCounts, pendingSequence.sequence[index])
        }
    }

    return tailCounts
}

function findC3Candidate<T>(
    pending: readonly PendingSequence<T>[],
    tailCounts: ReadonlyMap<T, number>
): Candidate<T> {
    for (const pendingSequence of pending) {
        const head = pendingSequence.sequence[pendingSequence.offset]

        if ((tailCounts.get(head) ?? 0) === 0) {
            return {
                found : true,
                value : head
            }
        }
    }

    return { found : false }
}

function consumeC3Candidate<T>(
    pending: PendingSequence<T>[],
    candidate: T,
    tailCounts: Map<T, number>
): void {
    for (let index = pending.length - 1; index >= 0; index--) {
        const pendingSequence = pending[index]

        if (pendingSequence.sequence[pendingSequence.offset] === candidate) {
            pendingSequence.offset++
            consumeNextTail(pendingSequence, tailCounts)
        }

        if (pendingSequence.offset === pendingSequence.sequence.length) {
            pending.splice(index, 1)
        }
    }
}

function consumeNextTail<T>(pendingSequence: PendingSequence<T>, tailCounts: Map<T, number>): void {
    if (pendingSequence.offset < pendingSequence.sequence.length) {
        decrementTailCount(tailCounts, pendingSequence.sequence[pendingSequence.offset])
    }
}

function incrementTailCount<T>(tailCounts: Map<T, number>, item: T): void {
    tailCounts.set(item, (tailCounts.get(item) ?? 0) + 1)
}

function decrementTailCount<T>(tailCounts: Map<T, number>, item: T): void {
    const currentCount = tailCounts.get(item)

    if (currentCount === undefined || currentCount <= 1) {
        tailCounts.delete(item)
    }
    else {
        tailCounts.set(item, currentCount - 1)
    }
}

function remainingSequences<T>(pending: readonly PendingSequence<T>[]): T[][] {
    return pending.map((pendingSequence) => {
        return pendingSequence.sequence.slice(pendingSequence.offset)
    })
}
