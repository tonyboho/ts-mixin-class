import { readFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import {
    createBenchmarkFixture,
    defaultEditScenarios,
    previousWindowPropertiesScenario,
    scenarioDirectoryName,
    type BenchmarkFixture,
    type BenchmarkScenario
} from "../fixtures/generator.js"
import type { BenchConfig } from "../lib/env.js"
import { scenarioSizes } from "../lib/env.js"
import { generatedRoot, packageRoot, tsserverFile } from "../lib/paths.js"
import type { BenchReport, BenchRow } from "../lib/report.js"
import { assertSuccessfulTsServerResponse, createTsServerSession, openFile } from "../lib/tsserver-session.js"

// Hottest IDE latency path: edit a mixin property initializer, then request the
// consumer's semantic diagnostics, repeated across a window of open mixin files.

export async function runTsServerEdit(config: BenchConfig): Promise<BenchReport> {
    const rows: BenchRow[] = []

    for (const scenario of editScenarios(config)) {
        const fixture = await createBenchmarkFixture({
            packageRoot,
            root : path.join(generatedRoot, "edit"),
            scenario
        })

        for (let index = 0; index < config.warmups; index++) {
            await runEditProcessingRequests(fixture, config.editCount)
        }

        const samples: number[] = []

        for (let index = 0; index < config.iterations; index++) {
            samples.push(...await runEditProcessingRequests(fixture, config.editCount))
        }

        rows.push({ name: scenarioDirectoryName(scenario), samples })
    }

    return { id: "tsserver-edit", title: "Tsserver edit processing", rows }
}

function editScenarios(config: BenchConfig): BenchmarkScenario[] {
    const sizes = scenarioSizes("TS_MIXIN_BENCH_EDIT_SIZES")

    return sizes === undefined
        ? defaultEditScenarios(config.propertyCount, config.graphOptions, config.propertyVisibility, config.construction)
        : sizes.map((size) => {
            return previousWindowPropertiesScenario(
                size, config.propertyCount, config.graphOptions, config.propertyVisibility, config.construction
            )
        })
}

async function runEditProcessingRequests(fixture: BenchmarkFixture, requestedEditCount: number): Promise<number[]> {
    const session    = createTsServerSession(tsserverFile, fixture.directory)
    const editFiles  = fixture.mixinFiles.slice(-Math.min(requestedEditCount, fixture.mixinFiles.length))
    const textByFile = new Map<string, string>()

    try {
        const consumerText = await readFile(fixture.consumerFile, "utf8")

        await openFile(session, fixture.consumerFile, consumerText)

        for (const fileName of editFiles) {
            const text = await readFile(fileName, "utf8")

            textByFile.set(fileName, text)
            await openFile(session, fileName, text)
        }

        assertSuccessfulTsServerResponse(
            await session.sendRequest("semanticDiagnosticsSync", { file: fixture.consumerFile }),
            "semanticDiagnosticsSync"
        )

        const durations: number[] = []

        for (let editIndex = 0; editIndex < requestedEditCount; editIndex++) {
            const fileName    = editFiles[editIndex % editFiles.length]!
            const currentText = textByFile.get(fileName)!
            const edit        = createMixinPropertyInitializerEdit(currentText, editIndex)
            const start       = performance.now()

            assertSuccessfulTsServerResponse(
                await session.sendRequest("change", {
                    file         : fileName,
                    line         : edit.line,
                    offset       : edit.offset,
                    endLine      : edit.endLine,
                    endOffset    : edit.endOffset,
                    insertString : edit.insertString
                }),
                "change"
            )
            assertSuccessfulTsServerResponse(
                await session.sendRequest("semanticDiagnosticsSync", { file: fixture.consumerFile }),
                "semanticDiagnosticsSync"
            )

            durations.push(performance.now() - start)
            textByFile.set(fileName, edit.nextText)
        }

        return durations
    } finally {
        await session.close()
    }
}

function createMixinPropertyInitializerEdit(
    text: string,
    editIndex: number
): {
    endLine      : number,
    endOffset    : number,
    insertString : string,
    line         : number,
    nextText     : string,
    offset       : number
} {
    const match = /value\d+_0: number = \d+/.exec(text)

    if (match === null) {
        throw new Error("Cannot find benchmark property initializer to edit")
    }

    const prefix        = match[0].replace(/\d+$/, "")
    const start         = match.index + prefix.length
    const end           = match.index + match[0].length
    const insertString  = String(10_000_000 + editIndex)
    const startPosition = positionToLineOffset(text, start)
    const endPosition   = positionToLineOffset(text, end)

    return {
        ...startPosition,
        endLine   : endPosition.line,
        endOffset : endPosition.offset,
        insertString,
        nextText  : text.slice(0, start) + insertString + text.slice(end)
    }
}

function positionToLineOffset(text: string, position: number): { line: number, offset: number } {
    const before = text.slice(0, position)
    const lines  = before.split("\n")

    return {
        line   : lines.length,
        offset : lines.at(-1)!.length + 1
    }
}
