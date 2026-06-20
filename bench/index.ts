import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { readBenchConfig, type BenchConfig } from "./lib/env.js"
import { resultsRoot } from "./lib/paths.js"
import {
    buildBaseline,
    loadBaseline,
    renderReports,
    saveBaseline,
    type BenchReport
} from "./lib/report.js"
import { runCompile } from "./scenarios/compile.js"
import { runTransformPass } from "./scenarios/transform-pass.js"
import { runTsServerDiagnostics } from "./scenarios/tsserver-diagnostics.js"
import { runTsServerEdit } from "./scenarios/tsserver-edit.js"

// Single benchmark entry point.
//
//   node dist/bench/index.js [scenario] [--full] [--save <name>] [--baseline <name>]
//
// scenario: all (default) | transform | compile | tsserver | edit
//   --full           full statistics table instead of the median-only compact one
//   --save <name>    write a baseline snapshot to bench/results/<name>.json
//   --baseline <name>  compare each row's median against that saved snapshot
//
// The compare loop: `--save base` before a change, `--baseline base` after it.
// Every run also writes its rendered output to bench/results/report.txt.

type Scenario = "all" | "compile" | "edit" | "transform" | "tsserver"

const transcript: string[] = []
const reportFile = path.join(resultsRoot, "report.txt")
const cli = parseArgs(process.argv.slice(2))
const config = withCliOverrides(readBenchConfig(), cli)
const baseline = cli.baseline === undefined ? undefined : await loadBaseline(baselineFile(cli.baseline))

printHeader(config, cli.scenario)

const reports = await runScenarios(cli.scenario, config)

for (const line of renderReports(reports, config.table, baseline)) {
    emit(line)
}

if (cli.save !== undefined) {
    const file = baselineFile(cli.save)

    await saveBaseline(file, buildBaseline(reports))
    emit("")
    emit(`Saved baseline to ${path.relative(process.cwd(), file)}`)
}

await writeReport()

async function runScenarios(scenario: Scenario, config: BenchConfig): Promise<BenchReport[]> {
    const reports: BenchReport[] = []

    if (scenario === "all" || scenario === "transform") {
        reports.push(runTransformPass(config))
    }

    if (scenario === "all" || scenario === "compile") {
        reports.push(await runCompile(config))
    }

    if (scenario === "all" || scenario === "tsserver") {
        reports.push(await runTsServerDiagnostics(config))
    }

    if (scenario === "all" || scenario === "edit") {
        reports.push(await runTsServerEdit(config))
    }

    return reports
}

function printHeader(config: BenchConfig, scenario: Scenario): void {
    emit("ts-mixin-class benchmarks")
    emit([
        `scenario=${scenario}`,
        `samples=${config.iterations}`,
        `warmups=${config.warmups}`,
        `table=${config.table}`
    ].join(" "))

    if (scenario === "all" || scenario === "transform") {
        emit(`transform-pass: innerIterations=${config.transformPassIterations} pass=${config.passMode}`)
    }

    if (scenario !== "transform") {
        emit([
            "fixtures:",
            `construction=${config.construction}`,
            `visibility=${config.propertyVisibility}`,
            `properties=${config.propertyCount}`,
            `deps=${config.graphOptions.minDependencyCount}-${config.graphOptions.maxDependencyCount}`,
            `window=${config.graphOptions.dependencyWindow}`,
            `seed=${config.graphOptions.seed}`
        ].join(" "))
    }
}

function withCliOverrides(config: BenchConfig, cli: CliArgs): BenchConfig {
    return cli.full ? { ...config, table : "full" } : config
}

type CliArgs = {
    scenario : Scenario,
    full     : boolean,
    save?    : string,
    baseline?: string
}

function parseArgs(args: string[]): CliArgs {
    const result: CliArgs = { scenario : "all", full : false }

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]!

        if (arg === "--full") {
            result.full = true
        } else if (arg === "--save") {
            result.save = requireValue(args, ++index, "--save")
        } else if (arg === "--baseline") {
            result.baseline = requireValue(args, ++index, "--baseline")
        } else if (!arg.startsWith("--")) {
            result.scenario = scenarioArg(arg)
        } else {
            throw new Error(`Unknown benchmark flag ${JSON.stringify(arg)}.`)
        }
    }

    return result
}

function requireValue(args: string[], index: number, flag: string): string {
    const value = args[index]

    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a name argument.`)
    }

    return value
}

function scenarioArg(value: string): Scenario {
    if (
        value === "all" || value === "compile" || value === "edit" ||
        value === "transform" || value === "tsserver"
    ) {
        return value
    }

    throw new Error(`Unknown benchmark scenario ${JSON.stringify(value)}. Use all, compile, edit, transform, or tsserver.`)
}

function baselineFile(name: string): string {
    return path.join(resultsRoot, name.endsWith(".json") ? name : `${name}.json`)
}

function emit(line = ""): void {
    console.log(line)
    transcript.push(line)
}

async function writeReport(): Promise<void> {
    await mkdir(resultsRoot, { recursive : true })
    await writeFile(reportFile, `${transcript.join("\n")}\n`)
    console.log("")
    console.log(`Report written to ${path.relative(process.cwd(), reportFile)}`)
}
