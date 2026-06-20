import { performance } from "node:perf_hooks"
import tsModule from "typescript"
import type * as ts from "typescript"
import { printSourceFile, transformSourceFile } from "../../src/index.js"
import {
    cloneSourceFileForTransform,
    preserveTopLevelStatementRanges,
    setParentRecursivePreservingVersion
} from "../../src/util.js"
import type { TypeScript } from "../../src/util.js"
import type { BenchConfig, PassMode } from "../lib/env.js"
import type { BenchReport, BenchRow } from "../lib/report.js"

// In-process microbenchmark for the per-file transform pipeline, with no tsc or
// tsserver around it. The end-to-end scenarios (compile, tsserver-*) dilute the
// transformer's own cost with TypeScript bind + check and process startup; this
// one isolates the steps the compiler host runs per file so an optimization can
// be judged before it is written.
//
//   source-view (tsserver / IDE): clone -> transform -> preserve ranges -> setParent
//   emit (compile):               transform -> print -> reparse

const tsInstance = tsModule as unknown as TypeScript
const fileName   = "/virtual/transform-pass.ts"
const target     = tsModule.ScriptTarget.ES2022

type TransformPassScenario = {
    name             : string,
    mixinCount       : number,
    propertyCount    : number,
    dependencyWindow : number,
    consumerCount    : number
}

export function runTransformPass(config: BenchConfig): BenchReport {
    const modes            = passModesFor(config.passMode)
    const rows: BenchRow[] = []

    for (const scenario of transformPassScenarios()) {
        const sourceFile = createSourceFile(scenario)

        for (const mode of modes) {
            rows.push(runScenario(scenario, mode, sourceFile, config, modes.length > 1))
        }
    }

    return { id: "transform-pass", title: "Transform-pass (in-process)", rows }
}

function runScenario(
    scenario: TransformPassScenario,
    mode: Exclude<PassMode, "both">,
    sourceFile: ts.SourceFile,
    config: BenchConfig,
    labelMode: boolean
): BenchRow {
    for (let index = 0; index < config.warmups; index++) {
        runSample(mode, sourceFile, config.transformPassIterations)
    }

    const samples: number[]                       = []
    const breakdownTotals: Record<string, number> = {}

    for (let index = 0; index < config.iterations; index++) {
        const steps = runSample(mode, sourceFile, config.transformPassIterations)
        let total   = 0

        for (const [ step, value ] of Object.entries(steps)) {
            breakdownTotals[step] = (breakdownTotals[step] ?? 0) + value
            total                += value
        }

        samples.push(total)
    }

    const breakdown: Record<string, number> = {}

    for (const [ step, value ] of Object.entries(breakdownTotals)) {
        breakdown[step] = value / config.iterations
    }

    return {
        name : labelMode ? `${scenario.name} · ${mode}` : scenario.name,
        samples,
        breakdown
    }
}

// One sample is `iterations` inner passes; returns the mean ms per pass per step.
function runSample(
    mode: Exclude<PassMode, "both">,
    sourceFile: ts.SourceFile,
    iterations: number
): Record<string, number> {
    const totals: Record<string, number> = {}
    const runPass                        = mode === "emit" ? runEmitOnce : runSourceViewOnce

    for (let index = 0; index < iterations; index++) {
        runPass(sourceFile, totals)
    }

    const divisor = Math.max(1, iterations)

    for (const step of Object.keys(totals)) {
        totals[step]! /= divisor
    }

    return totals
}

function runSourceViewOnce(sourceFile: ts.SourceFile, into: Record<string, number>): void {
    const cloned      = time(into, "clone", () => cloneSourceFileForTransform(tsInstance, sourceFile, target))
    const transformed = time(into, "xform", () => transformSourceFile(tsInstance, cloned, { sourceView: true }))

    if (transformed === cloned) {
        throw new Error("Generated transform-pass file was not transformed -- mixin detection failed")
    }

    time(into, "ranges", () => preserveTopLevelStatementRanges(tsInstance, transformed))
    time(into, "parent", () => setParentRecursivePreservingVersion(tsInstance, transformed, sourceFile))
}

function runEmitOnce(sourceFile: ts.SourceFile, into: Record<string, number>): void {
    const transformed = time(into, "xform", () => transformSourceFile(tsInstance, sourceFile, { sourceView: false }))

    if (transformed === sourceFile) {
        throw new Error("Generated transform-pass file was not transformed -- mixin detection failed")
    }

    const text = time(into, "print", () => printSourceFile(tsInstance, transformed))

    time(into, "reparse", () => tsModule.createSourceFile(fileName, text, target, true, tsModule.ScriptKind.TS))
}

function time<T>(into: Record<string, number>, step: string, run: () => T): T {
    const mark   = performance.now()
    const result = run()

    into[step] = (into[step] ?? 0) + (performance.now() - mark)

    return result
}

function passModesFor(passMode: PassMode): Exclude<PassMode, "both">[] {
    return passMode === "both" ? [ "source-view", "emit" ] : [ passMode ]
}

function createSourceFile(scenario: TransformPassScenario): ts.SourceFile {
    return tsModule.createSourceFile(fileName, generateSource(scenario), target, true, tsModule.ScriptKind.TS)
}

function transformPassScenarios(): TransformPassScenario[] {
    const scenarios = process.env.TS_MIXIN_BENCH_TRANSFORM_SCENARIOS

    if (scenarios === undefined) {
        return [
            scenario(25, 1, 4, 1),
            scenario(80, 3, 4, 1),
            scenario(80, 3, 4, 8),
            scenario(160, 3, 8, 8)
        ]
    }

    return scenarios.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
            const [ mixins, properties, window, consumers ] = entry.split(":")
                .map((value) => Number.parseInt(value.trim(), 10))

            if (
                !Number.isFinite(mixins) || mixins <= 0 ||
                !Number.isFinite(properties) || properties <= 0 ||
                !Number.isFinite(window) || window < 0 ||
                !Number.isFinite(consumers) || consumers <= 0
            ) {
                throw new Error(
                    "Invalid TS_MIXIN_BENCH_TRANSFORM_SCENARIOS entry " +
                    `${JSON.stringify(entry)}. Expected mixins:props:window:consumers.`
                )
            }

            return scenario(mixins!, properties!, window!, consumers!)
        })
}

function scenario(
    mixinCount: number,
    propertyCount: number,
    dependencyWindow: number,
    consumerCount: number
): TransformPassScenario {
    return {
        name : [
            `mixins-${mixinCount}`,
            `props-${propertyCount}`,
            `window-${dependencyWindow}`,
            `consumers-${consumerCount}`
        ].join("-"),
        mixinCount,
        propertyCount,
        dependencyWindow,
        consumerCount
    }
}

function generateSource(scenario: TransformPassScenario): string {
    const lines = [ `import { mixin } from "ts-mixin-class"`, "" ]

    for (let index = 0; index < scenario.mixinCount; index++) {
        const dependencies: string[] = []

        for (let offset = 1; offset <= scenario.dependencyWindow && index - offset >= 0; offset++) {
            if ((index + offset) % 2 === 0) {
                dependencies.push(`Mixin${index - offset}`)
            }
        }

        const implementsClause = dependencies.length === 0 ? "" : ` implements ${dependencies.join(", ")}`

        lines.push(`@mixin()`)
        lines.push(`export class Mixin${index}${implementsClause} {`)

        for (let property = 0; property < scenario.propertyCount; property++) {
            lines.push(`    value${index}_${property}: number = ${index * 1000 + property}`)
        }

        lines.push(`}`, "")
    }

    for (let consumer = 0; consumer < scenario.consumerCount; consumer++) {
        const leaves: string[] = []

        for (let index = scenario.mixinCount - 1 - consumer; index >= 0 && leaves.length < 8; index -= 2) {
            leaves.push(`Mixin${index}`)
        }

        lines.push(`export class Consumer${consumer} implements ${leaves.join(", ")} {`, `}`, "")
    }

    return lines.join("\n")
}
