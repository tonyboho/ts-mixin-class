import { execFile } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

// Standalone repro of the SUPER-QUADRATIC `addInheritedMembers` cost behind the
// base-chain compile curve (the third checker phenomenon of the AGENTS.md perf note —
// distinct from, and unaffected by, the upstream fixes #63555 and #63560; verified by
// applying both patches locally: the curve does not move).
//
// The distilled CORE needs only declared heritage over a deepening chain — no package,
// no transformer, one file:
//
//     class Base0 { b0: number = 0 }
//     class Base1 extends Base0 { b1: number = 1 }              // depth ~ size/4
//     …
//     interface Mixin0 extends Base0 { v0: number }
//     interface Mixin1 extends Base0, Mixin0 { v1: number }     // base index grows with i
//     …
//
// Each interface's member table transitively includes the whole chain below it, and the
// checker BUILDS that flattened table eagerly per declared type (`addInheritedMembers`,
// ~33% self-time in the profile, plus the GC pressure of the tables) — O(N) members per
// type × O(N) types. Check time grows ×5+ per size doubling (superquadratic tail), the
// type count exactly ×4 (quadratic). The FULL variant adds the mixin factory pattern
// around the same heritage (the intersection-typed `base` parameter and the inner class
// — the shapes this library emits), roughly tripling the same curve; the statics bags
// are immaterial (measured).
//
// Numbers on the pinned TS (2026-07-13), check time at sizes 30/80/160/320:
//   core: 0.02s / 0.07s / 0.20s / 1.08s      full: 0.06s / 0.15s / 0.52s / 3.01s

const execFileAsync = promisify(execFile)
const packageRoot   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const generatedRoot = path.join(packageRoot, "bench", "fixtures", "generated", "typescript-member-table-repro")
const tscFile       = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

type ReproVariant = "core" | "full"

type Scenario = {
    variant : ReproVariant,
    size    : number
}

type ScenarioResult = {
    scenario   : Scenario,
    checkTime? : string,
    totalTime? : string,
    types?     : string,
    timedOut   : boolean,
    wallMs?    : number
}

const sizes     = numberListEnv("TS_MEMBER_TABLE_REPRO_SIZES", [ 30, 80, 160, 320 ])
const variants  = variantListEnv("TS_MEMBER_TABLE_REPRO_VARIANTS", [ "core", "full" ])
const timeoutMs = numberEnv("TS_MEMBER_TABLE_REPRO_TIMEOUT_MS", 120_000)

const results: ScenarioResult[] = []

for (const variant of variants) {
    for (const size of sizes) {
        const scenario = { variant, size }
        const fixture  = await createFixture(scenario)

        results.push(await runScenario(scenario, fixture.tsconfigFile))
    }
}

printResults(results)

async function createFixture(scenario: Scenario): Promise<{ tsconfigFile: string }> {
    const directory    = path.join(generatedRoot, `${scenario.variant}-${scenario.size}`)
    const sourceFile   = path.join(directory, "index.ts")
    const tsconfigFile = path.join(directory, "tsconfig.json")

    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })

    await writeFile(sourceFile, reproSource(scenario))
    await writeFile(tsconfigFile, JSON.stringify(
        {
            compilerOptions : {
                module       : "ESNext",
                noEmit       : true,
                skipLibCheck : true,
                strict       : true,
                target       : "ES2022"
            },
            files : [ "index.ts" ]
        },
        null,
        4
    ))

    return { tsconfigFile }
}

function chainDepth(size: number): number {
    return Math.max(4, Math.round(size / 4))
}

// Monotonic with the interface index, like the bench corpus: deeper interfaces sit on
// deeper chain classes, so every heritage pair shares a growing chain prefix.
function baseIndex(size: number, index: number): number {
    const depth = chainDepth(size)

    return Math.min(depth - 1, Math.floor(index * depth / size))
}

function reproSource(scenario: Scenario): string {
    const lines: string[] = []

    if (scenario.variant === "full") {
        lines.push(
            "type AnyConstructor<T extends object = object> = new (...args: any[]) => T",
            "type ClassStatics<C> = Omit<C, \"prototype\">",
            "type RuntimeMixinClass<RB extends object = object> = { readonly marker?: RB }",
            ""
        )
    }

    const depth = chainDepth(scenario.size)

    for (let index = 0; index < depth; index++) {
        const heritage = index === 0 ? "" : ` extends Base${index - 1}`

        lines.push(`class Base${index}${heritage} { b${index}: number = ${index} }`)
    }

    lines.push("")

    for (let index = 0; index < scenario.size; index++) {
        const base = `Base${baseIndex(scenario.size, index)}`
        const dep  = index === 0 ? undefined : `Mixin${index - 1}`

        lines.push(`export interface Mixin${index} extends ${dep === undefined ? base : `${base}, ${dep}`} { v${index}: number }`)

        if (scenario.variant === "full") {
            const instance    = dep === undefined ? base : `${base} & ${dep}`
            const staticsTail = dep === undefined
                ? ` & ClassStatics<typeof ${base}>`
                : ` & ClassStatics<typeof ${base}> & Omit<ClassStatics<typeof ${dep}>, "marker">`
            const impl        = dep === undefined ? "" : ` implements ${dep}`

            lines.push(`export const __Mixin${index}$mixin = function (base: AnyConstructor<${instance}>${staticsTail}) {`)
            lines.push(`    class __Mixin${index}$class extends base${impl} { v${index}: number = ${index} }`)
            lines.push(`    return __Mixin${index}$class`)
            lines.push(`}`)
            lines.push(`export const Mixin${index} = 0 as unknown as AnyConstructor<Mixin${index}> & ClassStatics<typeof ${base}> & RuntimeMixinClass<${base}>`)
        }

        lines.push("")
    }

    return lines.join("\n")
}

async function runScenario(scenario: Scenario, tsconfigFile: string): Promise<ScenarioResult> {
    const start = performance.now()

    try {
        const { stderr, stdout } = await execFileAsync(
            process.execPath,
            [ tscFile, "-p", tsconfigFile, "--extendedDiagnostics" ],
            {
                timeout : timeoutMs
            }
        )
        const output             = `${stdout}\n${stderr}`

        return {
            scenario,
            checkTime : diagnosticValue(output, "Check time"),
            totalTime : diagnosticValue(output, "Total time"),
            types     : diagnosticValue(output, "Types"),
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

function diagnosticValue(output: string, label: string): string | undefined {
    const line = output.split(/\r?\n/u).find((entry) => entry.trimStart().startsWith(`${label}:`))

    return line?.trimStart().slice(label.length + 1).trim()
}

function printResults(results: ScenarioResult[]): void {
    console.log("TypeScript member-table (addInheritedMembers) repro")
    console.log(`timeout=${timeoutMs}ms`)
    console.log("")
    console.log("variant  size  wall      check     total     types")

    for (const result of results) {
        const check = result.timedOut ? "timeout" : result.checkTime ?? "n/a"
        const total = result.timedOut ? "timeout" : result.totalTime ?? "n/a"
        const types = result.timedOut ? "" : result.types ?? ""
        const wall  = result.wallMs === undefined ? "n/a" : `${result.wallMs.toFixed(1)}ms`

        console.log(
            `${result.scenario.variant.padEnd(8)} ${result.scenario.size.toString().padEnd(5)} ` +
            `${wall.padEnd(9)} ${check.padEnd(9)} ${total.padEnd(9)} ${types}`
        )
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

function variantListEnv(name: string, fallback: ReproVariant[]): ReproVariant[] {
    const value = process.env[name]

    if (value === undefined) {
        return fallback
    }

    const parsed = value.split(",")
        .map((entry) => entry.trim())
        .filter((entry): entry is ReproVariant => entry === "core" || entry === "full")

    return parsed.length === 0 ? fallback : parsed
}

function isTimeout(error: unknown): boolean {
    return typeof error === "object" &&
        error !== null &&
        "signal" in error &&
        (error as { signal?: unknown }).signal === "SIGTERM"
}
