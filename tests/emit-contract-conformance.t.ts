import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// A `@mixin` class that `implements` a contract but is *missing* a required member must
// be flagged by `tsc` (emit), not only by `tsc --noEmit` / the IDE (source view).
//
// The emit path lowers the mixin to a value cast `const X = defineMixinClass(...) as
// unknown as <type>`; the `as unknown as` double-cast erases the structural check
// between the runtime mixin body and the `implements` contract, and the generated
// `interface X extends Contract` *inherits* the contract's members instead of checking
// the class against them. So `tsc` stayed green while the IDE reported the violation —
// a CI-vs-editor divergence (the documented "coverage gap"). This pins emit to report
// the missing member too, at the mixin's source line.
const fixtureText = `import { mixin } from "ts-mixin-class"

export interface Greeter {
    greet(): string
}

@mixin()
export class GreeterMixin implements Greeter {
    name: string = "world"
}
`

const classSourceLine = fixtureText.split("\n").findIndex((line) => line.includes("class GreeterMixin")) + 1

// The source line of any diagnostic whose (possibly multi-line) message names the
// missing contract member `greet`. The member name lands on an indented continuation
// line — `Property 'greet' is missing…` — under a first line that only mentions the
// contract type, so the whole diagnostic block is captured.
function missingMemberDiagnosticLine(result: CommandResult): number | undefined {
    const output = commandOutput(result)

    for (const match of output.matchAll(/source\.ts\((\d+),\d+\): error TS\d+:[^\n]*(?:\n\s+[^\n]*)*/g)) {
        if (match[0].includes("'greet'")) {
            return Number(match[1])
        }
    }

    return undefined
}

it("emit (tsc) flags a mixin that does not satisfy its implements contract", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        sourceFiles            : [ { fileName : "source.ts", text : fixtureText } ]
    })
    const tsc     = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

    try {
        const emitResult       = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceViewResult = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile, "--noEmit" ], fixture.directory)

        const sourceViewLine = missingMemberDiagnosticLine(sourceViewResult)
        const emitLine       = missingMemberDiagnosticLine(emitResult)

        t.equal(sourceViewLine, classSourceLine,
            `source-view (--noEmit) should flag the missing 'greet' member on line ${classSourceLine}\n${commandOutput(sourceViewResult)}`)

        t.equal(emitLine, classSourceLine,
            `emit (tsc) should also flag the missing 'greet' member on line ${classSourceLine}, ` +
                `not stay silent (coverage gap)\n${commandOutput(emitResult)}`)
    } finally {
        await fixture.dispose()
    }
})
