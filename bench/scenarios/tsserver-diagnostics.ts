import { readFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import {
    createBenchmarkFixture,
    defaultTsServerScenarios,
    previousWindowPropertiesScenario,
    scenarioDirectoryName,
    type BenchmarkScenario
} from "../fixtures/generator.js"
import type { BenchConfig } from "../lib/env.js"
import { scenarioSizes } from "../lib/env.js"
import { generatedRoot, packageRoot, tsserverFile } from "../lib/paths.js"
import type { BenchReport, BenchRow } from "../lib/report.js"
import { assertSuccessfulTsServerResponse, createTsServerSession, openFile } from "../lib/tsserver-session.js"

// End-to-end source-view path: one `semanticDiagnosticsSync` request against a
// freshly opened consumer file in a real tsserver.

export async function runTsServerDiagnostics(config: BenchConfig): Promise<BenchReport> {
    const rows: BenchRow[] = []

    for (const scenario of diagnosticsScenarios(config)) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "tsserver"),
            scenario
        })

        for (let index = 0; index < config.warmups; index++) {
            await runSemanticDiagnosticsRequest(fixture.directory, fixture.consumerFile)
        }

        const samples: number[] = []

        for (let index = 0; index < config.iterations; index++) {
            samples.push(await runSemanticDiagnosticsRequest(fixture.directory, fixture.consumerFile))
        }

        rows.push({ name: scenarioDirectoryName(scenario), samples })
    }

    return { id: "tsserver-diagnostics", title: "Tsserver semantic diagnostics", rows }
}

function diagnosticsScenarios(config: BenchConfig): BenchmarkScenario[] {
    const sizes = scenarioSizes("TS_MIXIN_BENCH_TSSERVER_SIZES")

    return sizes === undefined
        ? defaultTsServerScenarios(config.propertyCount, config.graphOptions, config.propertyVisibility, config.construction)
        : sizes.map((size) => {
            return previousWindowPropertiesScenario(
                size, config.propertyCount, config.graphOptions, config.propertyVisibility, config.construction
            )
        })
}

async function runSemanticDiagnosticsRequest(fixtureDirectory: string, consumerFile: string): Promise<number> {
    const text    = await readFile(consumerFile, "utf8")
    const session = createTsServerSession(tsserverFile, fixtureDirectory)

    try {
        await openFile(session, consumerFile, text)

        const start    = performance.now()
        const response = await session.sendRequest("semanticDiagnosticsSync", { file: consumerFile })
        const duration = performance.now() - start

        assertSuccessfulTsServerResponse(response, "semanticDiagnosticsSync")

        return duration
    } finally {
        await session.close()
    }
}
