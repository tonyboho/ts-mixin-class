import { execFile } from "node:child_process"
import { rm } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"
import {
    createBenchmarkFixture,
    defaultCompileScenarios,
    previousWindowPropertiesScenario,
    scenarioDirectoryName,
    type BenchmarkScenario
} from "../fixtures/generator.js"
import type { BenchConfig } from "../lib/env.js"
import { scenarioSizes } from "../lib/env.js"
import { generatedRoot, packageRoot, tscFile } from "../lib/paths.js"
import type { BenchReport, BenchRow } from "../lib/report.js"

// End-to-end emit path: a clean `tsc -p` over a generated multi-file project.

const execFileAsync = promisify(execFile)

export async function runCompile(config: BenchConfig): Promise<BenchReport> {
    const rows: BenchRow[] = []

    for (const scenario of compileScenarios(config)) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "compile"),
            scenario
        })

        for (let index = 0; index < config.warmups; index++) {
            await runCleanCompile(fixture.tsconfigFile, fixture.directory)
        }

        const samples: number[] = []

        for (let index = 0; index < config.iterations; index++) {
            samples.push(await runCleanCompile(fixture.tsconfigFile, fixture.directory))
        }

        rows.push({ name : scenarioDirectoryName(scenario), samples })
    }

    return { id : "compile", title : "Compile (tsc -p)", rows }
}

function compileScenarios(config: BenchConfig): BenchmarkScenario[] {
    const sizes = scenarioSizes("TS_MIXIN_BENCH_SIZES")

    return sizes === undefined
        ? defaultCompileScenarios(config.propertyCount, config.graphOptions, config.propertyVisibility, config.construction)
        : sizes.map((size) => {
            return previousWindowPropertiesScenario(
                size, config.propertyCount, config.graphOptions, config.propertyVisibility, config.construction
            )
        })
}

async function runCleanCompile(tsconfigFile: string, directory: string): Promise<number> {
    await rm(path.join(directory, "dist"), { force : true, recursive : true })

    const start = performance.now()

    try {
        await execFileAsync(process.execPath, [ tscFile, "-p", tsconfigFile ], {
            cwd       : directory,
            maxBuffer : 10 * 1024 * 1024
        })
    } catch (error) {
        throw commandError("tsc", error)
    }

    return performance.now() - start
}

function commandError(command: string, error: unknown): Error {
    const failure = error as { message?: string, stdout?: string | Buffer, stderr?: string | Buffer }
    const stdout = outputToString(failure.stdout)
    const stderr = outputToString(failure.stderr)

    return new Error([
        `${command} failed`,
        stdout === "" ? undefined : `stdout:\n${stdout}`,
        stderr === "" ? undefined : `stderr:\n${stderr}`,
        failure.message
    ].filter((part) => part !== undefined && part !== "").join("\n\n"))
}

function outputToString(output: string | Buffer | undefined): string {
    return Buffer.isBuffer(output) ? output.toString("utf8") : output ?? ""
}
