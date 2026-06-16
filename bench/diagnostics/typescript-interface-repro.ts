import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const generatedRoot = path.join(packageRoot, "bench", "fixtures", "generated", "typescript-interface-repro")
const tscFile = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

type Scenario = {
    size   : number,
    props  : number,
    window : number
}

type ScenarioResult = {
    scenario  : Scenario,
    checkTime?: string,
    totalTime?: string,
    timedOut  : boolean
    wallMs?   : number
}

const sizes = numberListEnv("TS_INTERFACE_REPRO_SIZES", [ 25, 30, 32, 40 ])
const props = numberEnv("TS_INTERFACE_REPRO_PROPS", 20)
const windowSize = numberEnv("TS_INTERFACE_REPRO_WINDOW", 8)
const timeoutMs = numberEnv("TS_INTERFACE_REPRO_TIMEOUT_MS", 30_000)

const results: ScenarioResult[] = []

for (const size of sizes) {
    const scenario = { size, props, window : windowSize }
    const fixture = await createInterfaceFixture(scenario)
    results.push(await runScenario(scenario, fixture.tsconfigFile))
}

printResults(results)

async function createInterfaceFixture(scenario: Scenario): Promise<{ tsconfigFile: string }> {
    const directory = path.join(
        generatedRoot,
        `interfaces-${scenario.size}-props-${scenario.props}-window-${scenario.window}`
    )
    const sourceFile = path.join(directory, "index.ts")
    const tsconfigFile = path.join(directory, "tsconfig.json")

    await rm(directory, { recursive : true, force : true })
    await mkdir(directory, { recursive : true })

    await writeFile(sourceFile, interfaceSource(scenario))
    await writeFile(tsconfigFile, JSON.stringify({
        compilerOptions : {
            module       : "ESNext",
            noEmit       : true,
            skipLibCheck : true,
            strict       : true,
            target       : "ES2022"
        },
        files : [ "index.ts" ]
    }, null, 4))

    return { tsconfigFile }
}

function interfaceSource(scenario: Scenario): string {
    const lines: string[] = []

    for (let index = 0; index < scenario.size; index++) {
        const bases = baseNames(index, scenario.window)
        const heritage = bases.length === 0 ? "" : ` extends ${bases.join(", ")}`

        lines.push(`export interface I${index}${heritage} {`)

        for (let property = 0; property < scenario.props; property++) {
            lines.push(`    p${index}_${property}: number`)
        }

        lines.push("}", "")
    }

    lines.push(`export type Final = I${scenario.size - 1}`, "")

    return lines.join("\n")
}

function baseNames(index: number, windowSize: number): string[] {
    const names: string[] = []

    for (let offset = 1; offset <= Math.min(index, windowSize); offset++) {
        names.push(`I${index - offset}`)
    }

    return names
}

async function runScenario(scenario: Scenario, tsconfigFile: string): Promise<ScenarioResult> {
    const start = performance.now()

    try {
        const { stderr, stdout } = await execFileAsync(
            tscFile,
            [ "-p", tsconfigFile, "--extendedDiagnostics" ],
            {
                timeout : timeoutMs
            }
        )
        const output = `${stdout}\n${stderr}`

        return {
            scenario,
            checkTime : diagnosticTime(output, "Check time"),
            totalTime : diagnosticTime(output, "Total time"),
            timedOut  : false,
            wallMs    : performance.now() - start
        }
    }
    catch (error) {
        if (isTimeout(error)) {
            return {
                scenario,
                timedOut : true,
                wallMs   : performance.now() - start
            }
        }

        throw error
    }
}

function diagnosticTime(output: string, label: string): string | undefined {
    const line = output.split(/\r?\n/u).find((entry) => entry.trimStart().startsWith(`${label}:`))

    return line?.trimStart().slice(label.length + 1).trim()
}

function printResults(results: ScenarioResult[]): void {
    console.log("TypeScript interface inheritance repro")
    console.log(`props=${props} window=${windowSize} timeout=${timeoutMs}ms`)
    console.log("")
    console.log("size  wall      check     total")

    for (const result of results) {
        const check = result.timedOut ? "timeout" : result.checkTime ?? "n/a"
        const total = result.timedOut ? "timeout" : result.totalTime ?? "n/a"
        const wall = result.wallMs === undefined ? "n/a" : `${result.wallMs.toFixed(1)}ms`

        console.log(`${result.scenario.size.toString().padEnd(5)} ${wall.padEnd(9)} ${check.padEnd(9)} ${total}`)
    }
}

function numberEnv(name: string, fallback: number): number {
    const value = process.env[name]

    if (value === undefined) {
        return fallback
    }

    const parsed = Number.parseInt(value, 10)

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function numberListEnv(name: string, fallback: number[]): number[] {
    const value = process.env[name]

    if (value === undefined) {
        return fallback
    }

    const parsed = value.split(",")
        .map((entry) => Number.parseInt(entry.trim(), 10))
        .filter((entry) => Number.isFinite(entry) && entry > 0)

    return parsed.length === 0 ? fallback : parsed
}

function isTimeout(error: unknown): boolean {
    return typeof error === "object" &&
        error !== null &&
        "signal" in error &&
        (error as { signal?: unknown }).signal === "SIGTERM"
}
