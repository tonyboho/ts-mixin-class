import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// A diagnostic must point at the same SOURCE line whether the project is compiled in
// emit mode (`tsc`) or source-view mode (`tsc --noEmit`, which the IDE also uses).
//
// The emit path reprints the transformed program to text and reparses it, so a mixin
// expansion (which adds lines above) shifts every later diagnostic down — `tsc` then
// reports an error on a regenerated line that does not exist in the editor, while
// `tsc --noEmit` (position-preserving) reports it on the real source line. This test
// pins them to agree, on the real source line.
const fixtureText = `import { Base, mixin } from "ts-mixin-class"

@mixin()
export class Widget extends Base {
    value: number = 0
    method(): number { return this.value }
}

export const widget = Widget.new()

export const broken: string = widget.value
`

const realSourceLine = fixtureText.split("\n").findIndex((line) => line.includes("export const broken")) + 1

function diagnosticLine(result: CommandResult): number | undefined {
    const match = commandOutput(result).match(/source\.ts\((\d+),\d+\): error TS2322/)

    return match ? Number(match[1]) : undefined
}

it("reports a diagnostic on the same source line in emit and source-view modes", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        sourceFiles            : [ { fileName: "source.ts", text: fixtureText } ]
    })
    const tsc     = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

    try {
        const emitResult       = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceViewResult = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile, "--noEmit" ], fixture.directory)

        const emitLine       = diagnosticLine(emitResult)
        const sourceViewLine = diagnosticLine(sourceViewResult)

        t.equal(
            sourceViewLine,
            realSourceLine,
            `source-view (--noEmit) should report TS2322 on the real source line ${realSourceLine}\n${commandOutput(sourceViewResult)}`
        )

        t.equal(
            emitLine,
            realSourceLine,
            `emit (tsc) should report TS2322 on the real source line ${realSourceLine}, not a regenerated one\n${commandOutput(emitResult)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// A non-generic consumer takes the navigable-base fast path (`extends (Base as
// unknown as <single-source cast>)`). An incompatible member override must report the
// SAME TS2416 in both emit and source-view modes (a plain class-extends override
// error), and source view must NOT add the spurious TS2430 "interface incorrectly
// extends" that a merged-interface shape would produce.
const overrideConflictText = `import { mixin } from "ts-mixin-class"

class LocalBase {
    value: number = 0
}

@mixin()
class Feature {
    feature?: string
}

class Widget extends LocalBase implements Feature {
    value: string = ""
}
`

const overrideConflictLine = overrideConflictText.split("\n").findIndex((line) => line.includes("value: string")) + 1

function override2416Line(result: CommandResult): number | undefined {
    const match = commandOutput(result).match(/source\.ts\((\d+),\d+\): error TS2416/)

    return match ? Number(match[1]) : undefined
}

it("reports an incompatible override as TS2416 on the same source line in emit and source-view modes", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: overrideConflictText } ]
    })
    const tsc     = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

    try {
        const emitResult       = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceViewResult = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile, "--noEmit" ], fixture.directory)

        t.equal(
            override2416Line(sourceViewResult),
            overrideConflictLine,
            `source-view (--noEmit) should report TS2416 on the override line ${overrideConflictLine}\n${commandOutput(sourceViewResult)}`
        )

        t.equal(
            override2416Line(emitResult),
            overrideConflictLine,
            `emit (tsc) should report TS2416 on the override line ${overrideConflictLine}\n${commandOutput(emitResult)}`
        )

        t.notMatch(
            commandOutput(sourceViewResult),
            "TS2430",
            `source-view must not add a spurious TS2430 for the override conflict\n${commandOutput(sourceViewResult)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// Direct `new` on a construction class is disabled: construction goes through the
// generated static `new` factory. The construct signature is branded so a bare
// `new X()` reports TS2554 and `new X({ ... })` reports TS2353 carrying a descriptive
// guidance message — identically in emit and source-view modes. A class that declares
// its own constructor opts back into manual construction and keeps a working `super()`.
const disabledConstructionText = `import { Base, mixin } from "ts-mixin-class"

@mixin()
class Flag {
    touched: boolean = false
}

class Model extends Base {
    id: string = ""
}

class Widget extends Base implements Flag {
    name: string = ""
}

class Manual extends Base {
    value: string

    constructor () {
        super()
        this.value = ""
    }
}

export const okModel  = Model.new({ id : "x" })
export const okWidget = Widget.new({ name : "n", touched : true })
export const okManual = new Manual()

export const badBare   = new Model()
export const badConfig = new Widget({ name : "n", touched : true })
`

function lineOf(text: string, needle: string): number {
    return text.split("\n").findIndex((line) => line.includes(needle)) + 1
}

const badBareLine   = lineOf(disabledConstructionText, "badBare")
const badConfigLine = lineOf(disabledConstructionText, "badConfig")
const okManualLine  = lineOf(disabledConstructionText, "okManual")

it("disables direct `new` on construction classes with a descriptive error in emit and source-view modes", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: disabledConstructionText } ]
    })
    const tsc     = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

    try {
        const emitResult       = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceViewResult = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile, "--noEmit" ], fixture.directory)

        for (const result of [ emitResult, sourceViewResult ]) {
            const output = commandOutput(result)

            t.match(
                output,
                new RegExp(`source\\.ts\\(${badBareLine},\\d+\\): error TS2554`),
                `bare \`new Model()\` should be TS2554 on line ${badBareLine}\n${output}`
            )

            t.match(
                output,
                new RegExp(`source\\.ts\\(${badConfigLine},\\d+\\): error TS2353`),
                `\`new Widget({...})\` should be TS2353 on line ${badConfigLine}\n${output}`
            )

            t.match(
                output,
                "construction runs through the generated static `new` factory",
                `the TS2353 error should carry the descriptive guidance message\n${output}`
            )

            t.notMatch(
                output,
                new RegExp(`source\\.ts\\(${okManualLine},`),
                `a class with its own constructor keeps a working \`new\` (no error on line ${okManualLine})\n${output}`
            )
        }
    } finally {
        await fixture.dispose()
    }
})
