import { execFile } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"
import { integerEnv, scenarioSizes, type BenchConfig } from "../lib/env.js"
import { generatedRoot, tscFile } from "../lib/paths.js"
import type { BenchReport, BenchRow } from "../lib/report.js"

// A "what-if" comparison of how the generated `<Class>Config` type could be SHAPED, run over a
// deep `extends` hierarchy with many inherited properties. It does NOT exercise the transform; it
// hand-models the type surface each strategy would emit and compiles it with PLAIN `tsc`, so the
// numbers isolate the checker cost of the representation itself. Five shapes:
//
//   - baseline           : plain class chain, no config (anchor — the bare inheritance cost).
//   - flat               : `type CiConfig = Pick<Ci, all-accumulated-names>` (the CURRENT design).
//   - tree-import        : `type CiConfig = Pick<Ci, own> & C(i-1)Config` (incremental, by-name).
//   - tree-symbol        : a phantom `[CFG]` carrier on the INSTANCE type; `CiConfig = Ci[typeof CFG]`.
//   - tree-static-symbol : the same carrier on the STATIC side; `CiConfig = (typeof Ci)[typeof CFG]`
//                          (off the instance, so it dodges instance comparisons — but a static member
//                          cannot reference class type parameters (TS2302), so it can't carry generics).
//
// Each shape gets the SAME workload: declare the chain, force-resolve every config, and upcast each
// leaf to every ancestor (structural assignability — this is where an instance-side `[CFG]` is
// dragged into every comparison; a static-side one is not). It runs a DEPTH SWEEP so the curve is
// visible (flat ~O(depth^2), tree-import ~O(depth)). Tune with TS_MIXIN_BENCH_CONFIG_DEPTHS (a
// comma list, default `4,8,16,32`), TS_MIXIN_BENCH_CONFIG_CHAINS, TS_MIXIN_BENCH_CONFIG_PROPS.

type ShapeName = "baseline" | "flat" | "tree-import" | "tree-symbol" | "tree-static-symbol"

type Dimensions = {
    chains : number,
    depth  : number,
    props  : number
}

const SHAPES: ShapeName[] = [ "baseline", "flat", "tree-import", "tree-symbol", "tree-static-symbol" ]

export async function runConfigShape(config: BenchConfig): Promise<BenchReport> {
    const sweep            = readSweep()
    const rows: BenchRow[] = []

    // Outer loop is the SHAPE so each shape's depth points are contiguous — read its check column
    // down the rows to see the curve (flat ~O(depth^2); tree-import ~O(depth)).
    for (const shape of SHAPES) {
        for (const depth of sweep.depths) {
            const dimensions: Dimensions = { chains: sweep.chains, depth, props: sweep.props }
            const directory              = path.join(generatedRoot, "config-shape", shape)

            await mkdir(directory, { recursive: true })
            await writeFile(path.join(directory, "tsconfig.json"), TSCONFIG)
            await writeFile(path.join(directory, "source.ts"), generateShape(shape, dimensions))

            for (let index = 0; index < config.warmups; index++) {
                await compile(directory)
            }

            const samples: number[] = []
            let breakdown: Record<string, number> | undefined

            for (let index = 0; index < config.iterations; index++) {
                const run = await compile(directory)

                samples.push(run.elapsed)
                breakdown = run.timings
            }

            rows.push({ name: `${shape} @ depth ${depth} (${depth * sweep.props} acc)`, samples, breakdown })
        }
    }

    return {
        id    : "config-shape",
        title : `Config shape scaling (plain tsc; ${sweep.chains} chains x ${sweep.props} props/level; depth sweep ${sweep.depths.join(", ")})`,
        rows
    }
}

type Sweep = {
    chains : number,
    props  : number,
    depths : number[]
}

function readSweep(): Sweep {
    return {
        chains : integerEnv("TS_MIXIN_BENCH_CONFIG_CHAINS", 15),
        props  : integerEnv("TS_MIXIN_BENCH_CONFIG_PROPS", 6),
        depths : scenarioSizes("TS_MIXIN_BENCH_CONFIG_DEPTHS") ?? [ 4, 8, 16, 32 ]
    }
}

const TSCONFIG = `${JSON.stringify(
    {
        compilerOptions : {
            strict           : true,
            target           : "ES2022",
            module           : "ESNext",
            moduleResolution : "Bundler",
            noEmit           : true,
            skipLibCheck     : true
        }
    },
    null,
    4
)}\n`

// ---- shape generators (the emitted type surface, hand-modeled) ----

function ownProps(props: number, c: number, i: number): string {
    return Array.from({ length: props }, (_, j) => `  public p${c}_${i}_${j}!: number\n`).join("")
}

function ownNames(props: number, c: number, i: number): string {
    return Array.from({ length: props }, (_, j) => `"p${c}_${i}_${j}"`).join(" | ")
}

function allNames(props: number, c: number, upto: number): string {
    return Array.from({ length: upto + 1 }, (_, i) => ownNames(props, c, i)).join(" | ")
}

function ownLiteral(props: number, c: number, i: number): string {
    return Array.from({ length: props }, (_, j) => `p${c}_${i}_${j}: number`).join("; ")
}

function classHeader(c: number, i: number): string {
    return i === 0 ? `class C${c}_${i} {` : `class C${c}_${i} extends C${c}_${i - 1} {`
}

function upcasts(depth: number, c: number): string {
    let s = `const leaf${c} = null as any as C${c}_${depth - 1}\n`

    for (let k = 0; k < depth; k++) {
        s += `const up${c}_${k}: C${c}_${k} = leaf${c}; void up${c}_${k}\n`
    }

    return s
}

const forceConfig = (c: number, i: number): string =>
    `const _cfg${c}_${i}: C${c}_${i}Config = null as any; void _cfg${c}_${i}\n`

function generateShape(shape: ShapeName, dimensions: Dimensions): string {
    const { chains, depth, props } = dimensions
    const needsSymbol              = shape === "tree-symbol" || shape === "tree-static-symbol"
    let   text                     = needsSymbol ? "declare const CFG: unique symbol\n" : ""

    for (let c = 0; c < chains; c++) {
        for (let i = 0; i < depth; i++) {
            if (shape === "tree-symbol") {
                const parentConfig = i > 0 ? `C${c}_${i - 1}[typeof CFG] & ` : ""

                text += `interface C${c}_${i} { readonly [CFG]: ${parentConfig}{ ${ownLiteral(props, c, i)} } }\n`
            }

            const staticCarrier = shape === "tree-static-symbol"
                ? `  declare static readonly [CFG]: ${i > 0 ? `(typeof C${c}_${i - 1})[typeof CFG] & ` : ""}{ ${ownLiteral(props, c, i)} }\n`
                : ""

            text += `${classHeader(c, i)}\n${ownProps(props, c, i)}${staticCarrier}}\n`

            if (shape === "flat") {
                text += `type C${c}_${i}Config = Pick<C${c}_${i}, ${allNames(props, c, i)}>\n${forceConfig(c, i)}`
            } else if (shape === "tree-import") {
                const parent = i > 0 ? ` & C${c}_${i - 1}Config` : ""

                text += `type C${c}_${i}Config = Pick<C${c}_${i}, ${ownNames(props, c, i)}>${parent}\n${forceConfig(c, i)}`
            } else if (shape === "tree-symbol") {
                text += `type C${c}_${i}Config = C${c}_${i}[typeof CFG]\n${forceConfig(c, i)}`
            } else if (shape === "tree-static-symbol") {
                text += `type C${c}_${i}Config = (typeof C${c}_${i})[typeof CFG]\n${forceConfig(c, i)}`
            }
        }

        text += upcasts(depth, c)
    }

    return text
}

// ---- compile + extended-diagnostics timings ----

const execFileAsync = promisify(execFile)

type CompileRun = {
    elapsed : number,
    timings : Record<string, number>
}

async function compile(directory: string): Promise<CompileRun> {
    const start  = performance.now()
    let   output = ""

    try {
        const result = await execFileAsync(
            process.execPath,
            [ tscFile, "-p", "tsconfig.json", "--extendedDiagnostics" ],
            { cwd: directory, maxBuffer: 64 * 1024 * 1024 }
        )

        output = result.stdout + result.stderr
    } catch (error) {
        const failure = error as { stdout?: string | Buffer, stderr?: string | Buffer, message?: string }

        // A shape with a deliberate type error would still print diagnostics; surface a real failure.
        output = `${toString(failure.stdout)}${toString(failure.stderr)}`

        if (output.trim() === "") {
            throw new Error(`tsc failed in ${directory}: ${failure.message ?? "unknown error"}`)
        }
    }

    return { elapsed: performance.now() - start, timings: parseTimings(output) }
}

// The `breakdown` columns are durations (ms), so we surface only the internal `--extendedDiagnostics`
// TIMINGS (converted s -> ms): `check` (the checker phase, where an instance-side `[CFG]` shows up
// in every structural comparison) and `total` (tsc's own total, free of node startup that the
// wall-clock `samples` carry). The deterministic COUNTS (Types / Instantiations / Assignability cache
// size) are not durations and would mislabel as ms; read them directly via `tsc --extendedDiagnostics`
// when the why behind a delta matters — e.g. tree-symbol's Assignability cache size balloons.
function parseTimings(output: string): Record<string, number> {
    const seconds = (label: string): number =>
        Number((output.match(new RegExp(`${label}:\\s+([\\d.]+)s`)) ?? [])[1] ?? Number.NaN)

    return {
        check : seconds("Check time") * 1000,
        total : seconds("Total time") * 1000
    }
}

function toString(output: string | Buffer | undefined): string {
    return Buffer.isBuffer(output) ? output.toString("utf8") : output ?? ""
}
