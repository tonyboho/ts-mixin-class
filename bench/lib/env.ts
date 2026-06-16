import {
    defaultPreviousWindowGraphOptions,
    type BenchmarkConstructionMode,
    type BenchmarkPropertyVisibility,
    type PreviousWindowGraphOptions
} from "../fixtures/generator.js"
import type { TableMode } from "./report.js"

// Centralized environment-variable parsing. Every scenario reads its tunables
// from one BenchConfig so the knobs live in a single place instead of being
// re-parsed across files.

export type PassMode = "both" | "emit" | "source-view"

export type BenchConfig = {
    iterations              : number,
    warmups                 : number,
    table                   : TableMode,
    propertyCount           : number,
    propertyVisibility      : BenchmarkPropertyVisibility,
    construction            : BenchmarkConstructionMode,
    editCount               : number,
    transformPassIterations : number,
    passMode                : PassMode,
    graphOptions            : PreviousWindowGraphOptions
}

export function readBenchConfig(): BenchConfig {
    const defaults = defaultPreviousWindowGraphOptions()

    return {
        iterations              : integerEnv("TS_MIXIN_BENCH_ITERATIONS", 3),
        warmups                 : integerEnv("TS_MIXIN_BENCH_WARMUPS", 1),
        table                   : tableMode(),
        propertyCount           : integerEnv("TS_MIXIN_BENCH_PROPERTY_COUNT", 1),
        propertyVisibility      : propertyVisibility(),
        construction            : constructionMode(),
        editCount               : integerEnv("TS_MIXIN_BENCH_EDIT_COUNT", 8),
        transformPassIterations : integerEnv("TS_MIXIN_BENCH_TRANSFORM_ITERATIONS", 80),
        passMode                : passMode(),
        graphOptions            : {
            dependencyWindow   : integerEnv("TS_MIXIN_BENCH_DEP_WINDOW", defaults.dependencyWindow),
            maxDependencyCount : integerEnv("TS_MIXIN_BENCH_DEP_MAX", defaults.maxDependencyCount),
            minDependencyCount : integerEnv("TS_MIXIN_BENCH_DEP_MIN", defaults.minDependencyCount),
            seed               : integerEnv("TS_MIXIN_BENCH_SEED", defaults.seed)
        }
    }
}

export function integerEnv(name: string, fallback: number): number {
    const value = process.env[name]

    if (value === undefined) {
        return fallback
    }

    const parsed = Number.parseInt(value, 10)

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function scenarioSizes(specificEnvName: string): number[] | undefined {
    const sizes = process.env[specificEnvName] ?? process.env.TS_MIXIN_BENCH_SIZES

    return sizes?.split(",")
        .map((size) => Number.parseInt(size.trim(), 10))
        .filter((size) => Number.isFinite(size) && size > 0)
}

function tableMode(): TableMode {
    const value = process.env.TS_MIXIN_BENCH_TABLE ?? "compact"

    if (value === "compact" || value === "full") {
        return value
    }

    throw new Error(`Unknown TS_MIXIN_BENCH_TABLE ${JSON.stringify(value)}. Use compact or full.`)
}

function passMode(): PassMode {
    const value = process.env.TS_MIXIN_BENCH_PASS_MODE ?? "both"

    if (value === "both" || value === "emit" || value === "source-view") {
        return value
    }

    throw new Error(`Unknown TS_MIXIN_BENCH_PASS_MODE ${JSON.stringify(value)}. Use both, emit, or source-view.`)
}

function propertyVisibility(): BenchmarkPropertyVisibility {
    const value = process.env.TS_MIXIN_BENCH_PROPERTY_VISIBILITY ?? "implicit"

    if (value === "implicit" || value === "public") {
        return value
    }

    throw new Error(
        `Unknown TS_MIXIN_BENCH_PROPERTY_VISIBILITY ${JSON.stringify(value)}. Use implicit or public.`
    )
}

function constructionMode(): BenchmarkConstructionMode {
    const value = process.env.TS_MIXIN_BENCH_CONSTRUCTION ?? "plain"

    if (value === "plain" || value === "base") {
        return value
    }

    throw new Error(`Unknown TS_MIXIN_BENCH_CONSTRUCTION ${JSON.stringify(value)}. Use plain or base.`)
}
