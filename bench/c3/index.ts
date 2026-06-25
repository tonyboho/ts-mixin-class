import { performance } from "node:perf_hooks"
import { mergeC3Linearizations } from "../../src/c3-linearization.js"

// Standalone microbenchmark for the linearization step ONLY -- no `@mixin`, no
// transformer, no tsc. It compares the two runtime strategies on abstract
// dependency graphs (nodes are plain integers):
//
//   C3     -- what the runtime does today: for each node, merge its direct
//             dependencies' linearizations with the real `mergeC3Linearizations`.
//   replay -- approach (B): the compiler has already run C3 and emitted, per node,
//             a `merge plan` (a list of contiguous slices over its dependencies'
//             linearizations). The runtime just splices -- no merge, no Map, no
//             good-head search; only array index reads.
//
// Plan derivation is COMPILE-TIME work, so it is timed separately and is not part
// of the runtime comparison. Both strategies build every node's full linearization
// bottom-up; the bench asserts they produce identical results before timing.
//
//   node dist/bench/c3/index.js
//
// Tunables (env): TS_MIXIN_C3_SIZES, TS_MIXIN_C3_WINDOW, TS_MIXIN_C3_DEP_MIN,
// TS_MIXIN_C3_DEP_MAX, TS_MIXIN_C3_SAMPLES, TS_MIXIN_C3_WARMUPS, TS_MIXIN_C3_SEED.

type Slice = {
    src    : number,
    offset : number,
    length : number
}

const sizes   = listEnv("TS_MIXIN_C3_SIZES", [ 64, 256, 1024 ])
const window  = intEnv("TS_MIXIN_C3_WINDOW", 24)
const depMin  = intEnv("TS_MIXIN_C3_DEP_MIN", 1)
const depMax  = intEnv("TS_MIXIN_C3_DEP_MAX", 4)
const samples = intEnv("TS_MIXIN_C3_SAMPLES", 7)
const warmups = intEnv("TS_MIXIN_C3_WARMUPS", 2)
const seed    = intEnv("TS_MIXIN_C3_SEED", 19871)

main()

function main(): void {
    print("ts-mixin-class C3 linearization benchmark")
    print([
        `sizes=${sizes.join(",")}`,
        `window=${window}`,
        `deps=${depMin}-${depMax}`,
        `samples=${samples}`,
        `warmups=${warmups}`,
        `seed=${seed}`
    ].join(" "))
    print("")
    print(header())

    for (const size of sizes) {
        print(row(size, measure(size)))
    }
}

type Measurement = {
    avgLinLength : number,
    totalElems   : number,
    avgSlices    : number,
    c3Median     : number,
    replayMedian : number,
    cArrayMedian : number,
    cUuidMedian  : number,
    deriveMedian : number
}

function measure(size: number): Measurement {
    // `reference` is the C3 result captured while constructing a consistent graph;
    // it is the source of truth for plan derivation + correctness. The timed `C3`
    // strategy below re-runs the merge on the same (now conflict-free) graph.
    const { dependencies, reference } = buildConsistentGraph(size)
    const plans                       = derivePlans(dependencies, reference)

    // Variant C resolves each node's PRECOMPUTED flat id list (the literal the compiler
    // would emit) to values through a registry -- no per-node assembly, no bottom-up.
    //   C-array: dense integer registry, `registry[id]` (single-package, non-persistent ids)
    //   C-uuid : Map keyed by a 36-char uuid string (the only cross-package-persistent id)
    // The id lists and registries are the emitted/loaded artifacts, built once and untimed.
    const arrayRegistry: number[] = []
    const uuidOf: string[]        = []

    for (let node = 0; node < size; node++) {
        arrayRegistry[node] = node
        uuidOf[node]        = makeUuid(node)
    }

    const uuidRegistry = new Map<string, number>(uuidOf.map((uuid, node): [ string, number ] => [ uuid, node ]))
    const uuidLists    = reference.map((lin) => lin.map((id) => uuidOf[id]!))

    // Every strategy must reproduce the C3 result exactly.
    assertEqual(reference, buildWithReplay(dependencies, plans))
    assertEqual(reference, resolveWithArrayRegistry(reference, arrayRegistry))
    assertEqual(reference, resolveWithUuidRegistry(uuidLists, uuidRegistry))

    return {
        avgLinLength : reference.reduce((sum, lin) => sum + lin.length, 0) / size,
        totalElems   : reference.reduce((sum, lin) => sum + lin.length, 0),
        avgSlices    : plans.reduce((sum, plan) => sum + plan.length, 0) / size,
        c3Median     : timed(() => buildWithC3(dependencies)),
        replayMedian : timed(() => buildWithReplay(dependencies, plans)),
        cArrayMedian : timed(() => resolveWithArrayRegistry(reference, arrayRegistry)),
        cUuidMedian  : timed(() => resolveWithUuidRegistry(uuidLists, uuidRegistry)),
        deriveMedian : timed(() => derivePlans(dependencies, reference))
    }
}

// --- the two runtime strategies --------------------------------------------

// Today's runtime: each node's linearization is `[node, ...C3-merge(deps)]`,
// built bottom-up so each dependency's linearization is already available.
function buildWithC3(dependencies: number[][]): number[][] {
    const linearizations: number[][] = []

    for (let node = 0; node < dependencies.length; node++) {
        const deps   = dependencies[node]!
        const merged = deps.length === 0
            ? []
            : mergeC3Linearizations([ ...deps.map((dep) => linearizations[dep]!), deps ])

        linearizations[node] = [ node, ...merged ]
    }

    return linearizations
}

// Approach (B): replay the precomputed slice plan. No merge, no Map, no search --
// only `result.push(source[offset + i])`.
function buildWithReplay(dependencies: number[][], plans: Slice[][]): number[][] {
    const linearizations: number[][] = []

    for (let node = 0; node < dependencies.length; node++) {
        const deps    = dependencies[node]!
        const sources = sourcesFor(deps, linearizations)
        const result  = [ node ]

        for (const slice of plans[node]!) {
            const source = sources[slice.src]!
            const end    = slice.offset + slice.length

            for (let index = slice.offset; index < end; index++) {
                result.push(source[index]!)
            }
        }

        linearizations[node] = result
    }

    return linearizations
}

// --- variant C: resolve a precomputed flat id list -------------------------

// C-array: the emitted flat list IS the node's id sequence; resolve each id with a
// dense-array index. Fast, but the ids are sequential per-compilation -> not persistent
// and not portable across packages (see the README persistence discussion).
function resolveWithArrayRegistry(idLists: number[][], registry: number[]): number[][] {
    const resolved: number[][] = []

    for (let node = 0; node < idLists.length; node++) {
        const ids    = idLists[node]!
        const result = []

        for (let index = 0; index < ids.length; index++) {
            result.push(registry[ids[index]!]!)
        }

        resolved[node] = result
    }

    return resolved
}

// C-uuid: the emitted flat list is uuid STRINGS (the only cross-package-persistent id);
// resolve each through a Map keyed by the string. The realistic cross-package C.
function resolveWithUuidRegistry(uuidLists: string[][], registry: Map<string, number>): number[][] {
    const resolved: number[][] = []

    for (let node = 0; node < uuidLists.length; node++) {
        const uuids  = uuidLists[node]!
        const result = []

        for (let index = 0; index < uuids.length; index++) {
            result.push(registry.get(uuids[index]!)!)
        }

        resolved[node] = result
    }

    return resolved
}

// A deterministic 36-char uuid-shaped string per node, to model the cross-package id's
// string-key Map lookups (hash cost scales with the ~36-char length).
function makeUuid(value: number): string {
    const a = (Math.imul(value, 2654435761) >>> 0).toString(16).padStart(8, "0")
    const b = ((value ^ 0x9e3779b9) >>> 0).toString(16).padStart(8, "0")

    return `${a}-${b.slice(0, 4)}-4${b.slice(4, 7)}-8${a.slice(0, 3)}-${a}${b.slice(0, 4)}`
}

// --- compile-time plan derivation ------------------------------------------

// For each node, derive the slice plan from the already-computed C3 result by
// attributing every output element to a source sequence (its cursor) and
// coalescing contiguous same-source runs. Monotonicity guarantees a source whose
// cursor points at the element always exists.
function derivePlans(dependencies: number[][], reference: number[][]): Slice[][] {
    const plans: Slice[][] = []

    for (let node = 0; node < dependencies.length; node++) {
        const deps          = dependencies[node]!
        const sources       = sourcesFor(deps, reference)
        const merged        = reference[node]!.slice(1)
        const cursors       = sources.map(() => 0)
        const plan: Slice[] = []

        for (const element of merged) {
            const pick = sources.findIndex((source, index) => source[cursors[index]!] === element)
            const last = plan[plan.length - 1]

            if (last !== undefined && last.src === pick && last.offset + last.length === cursors[pick]!) {
                last.length++
            } else {
                plan.push({ src: pick, offset: cursors[pick]!, length: 1 })
            }

            for (let index = 0; index < sources.length; index++) {
                if (sources[index]![cursors[index]!] === element) {
                    cursors[index]!++
                }
            }
        }

        plans[node] = plan
    }

    return plans
}

// The merge inputs for a node: each dependency's full linearization, then the
// direct dependency list itself (matching `linearizeRuntimeRequirements`).
function sourcesFor(deps: number[], linearizations: number[][]): number[][] {
    return [ ...deps.map((dep) => linearizations[dep]!), deps ]
}

// --- graph generation ------------------------------------------------------

// A random acyclic graph that is guaranteed C3-consistent. Node `i` draws a few
// dependencies from the window `[i - window, i - 1]` (descending, so the common
// case agrees with the global id order). A descending order is NOT sufficient on
// its own -- C3 emits the leftmost good head, so deep windows can still produce a
// genuine conflict -- so each node's merge is attempted while constructing the
// graph and the smallest dependency is dropped until the merge succeeds. This
// keeps every diamond that does not conflict and removes only the ones that would.
function buildConsistentGraph(size: number): { dependencies: number[][], reference: number[][] } {
    const random                   = lcg(seed + size)
    const dependencies: number[][] = []
    const reference: number[][]    = []

    for (let node = 0; node < size; node++) {
        const lowest = Math.max(0, node - window)
        const span   = node - lowest
        const wanted = span === 0 ? 0 : depMin + Math.floor(random() * (depMax - depMin + 1))
        const picked = new Set<number>()

        while (picked.size < Math.min(wanted, span)) {
            picked.add(lowest + Math.floor(random() * span))
        }

        const deps = [ ...picked ].sort((left, right) => right - left)

        // Back off (drop the smallest dependency) until the node linearizes.
        for (;;) {
            const merged = tryMerge(deps, reference)

            if (merged !== undefined) {
                dependencies[node] = deps
                reference[node]    = [ node, ...merged ]
                break
            }

            deps.pop()
        }
    }

    return { dependencies, reference }
}

function tryMerge(deps: number[], reference: number[][]): number[] | undefined {
    if (deps.length === 0) {
        return []
    }

    try {
        return mergeC3Linearizations([ ...deps.map((dep) => reference[dep]!), deps ])
    } catch {
        return undefined
    }
}

function lcg(state: number): () => number {
    let value = state >>> 0

    return () => {
        value = (Math.imul(value, 1664525) + 1013904223) >>> 0

        return value / 0x100000000
    }
}

// --- timing + output -------------------------------------------------------

function timed(run: () => unknown): number {
    for (let index = 0; index < warmups; index++) {
        run()
    }

    const durations: number[] = []

    for (let index = 0; index < samples; index++) {
        const mark = performance.now()

        run()
        durations.push(performance.now() - mark)
    }

    return median(durations)
}

function median(values: number[]): number {
    const sorted = [ ...values ].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)

    return sorted.length % 2 === 0
        ? (sorted[middle - 1]! + sorted[middle]!) / 2
        : sorted[middle]!
}

function header(): string {
    return columns([ "nodes", "avg|L|", "avg slices", "C3", "B replay", "C-array", "C-uuid", "derive" ])
}

function row(size: number, measurement: Measurement): string {
    return columns([
        String(size),
        measurement.avgLinLength.toFixed(1),
        measurement.avgSlices.toFixed(1),
        ms(measurement.c3Median),
        ms(measurement.replayMedian),
        ms(measurement.cArrayMedian),
        ms(measurement.cUuidMedian),
        ms(measurement.deriveMedian)
    ])
}

function columns(cells: string[]): string {
    return cells.map((cell, index) => index === 0 ? cell.padEnd(8) : cell.padStart(12)).join(" ")
}

function ms(value: number): string {
    return `${value.toFixed(value < 10 ? 3 : 1)}ms`
}

function assertEqual(expected: number[][], actual: number[][]): void {
    for (let node = 0; node < expected.length; node++) {
        const left  = expected[node]!
        const right = actual[node]!

        if (left.length !== right.length || left.some((value, index) => value !== right[index])) {
            throw new Error(`replay linearization differs from C3 at node ${node}`)
        }
    }
}

function listEnv(name: string, fallback: number[]): number[] {
    const raw = process.env[name]

    if (raw === undefined || raw.trim().length === 0) {
        return fallback
    }

    return raw.split(",").map((entry) => Number.parseInt(entry.trim(), 10)).filter((value) => value > 0)
}

function intEnv(name: string, fallback: number): number {
    const raw = process.env[name]

    if (raw === undefined || raw.trim().length === 0) {
        return fallback
    }

    return Number.parseInt(raw.trim(), 10)
}

function print(line: string): void {
    console.log(line)
}
