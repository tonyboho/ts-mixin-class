import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource } from "./construction-build-util.js"
import { assertResponseBody, runTypeScriptServerRequest } from "./tsserver-util.js"
import { commandOutput, createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"

// Two mixins declare the same method with INCOMPATIBLE return types (`Left` a literal type,
// `Right` a plain `string`), and a consumer applies both. TypeScript must reject the
// consumer — but the diagnostic has to land on the consumer's own `implements` clause, not on
// whatever unrelated statement happens to precede the class (the generated `$base` sibling is
// spliced before the consumer, so a badly anchored diagnostic points at `const x = 15`).
// The source-view rendering must also never print a garbage type name read from that
// unrelated text (`Interface '5' …`). Found through the example project (`linearization.ts`).
const source = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Root {
        print(): string {
            return "Root"
        }
    }

    @mixin()
    class Left implements Root {
        print(): \`Left\` {
            return \`Left\`
        }
    }

    @mixin()
    class Right implements Root {
        print(): string {
            return \`Right > \${super.print()}\`
        }
    }

    const x = 15

    class Combined implements Left, Right {
        print(): string {
            return \`Combined > \${super.print()}\`
        }
    }

    void x
    void Combined
`)

const sourceLines   = source.split("\n")
const unrelatedLine = sourceLines.findIndex((line) => line.includes("const x = 15")) + 1
const consumerLine  = sourceLines.findIndex((line) => line.includes("class Combined implements")) + 1

type TscDiagnostic = { line: number, code: string }

function tscDiagnostics(output: string): TscDiagnostic[] {
    return [ ...output.matchAll(/source\.ts\((\d+),\d+\): error (TS\d+)/g) ]
        .map((match) => ({ line: Number(match[1]), code: match[2] }))
}

it("a mixin member type conflict is anchored on the consumer, not on the preceding statement, in both planes", async (t: Test) => {
    for (const [ plane, options ] of [ [ "emit", undefined ], [ "source view", { noEmit: true } ] ] as const) {
        const result      = await buildConstructionSource(source, options)
        const output      = commandOutput(result)
        const diagnostics = tscDiagnostics(output)

        t.ne(result.exitCode, 0, `${plane}: incompatible member types are rejected\n${output}`)

        t.eq(
            diagnostics.filter((diagnostic) => diagnostic.line === unrelatedLine),
            [],
            `${plane}: nothing is reported on the unrelated \`const x = 15\` line ${unrelatedLine}\n${output}`
        )

        t.true(
            diagnostics.some((diagnostic) => diagnostic.line === consumerLine),
            `${plane}: the conflict is reported on the consumer's own line ${consumerLine}\n${output}`
        )

        t.notMatch(
            output,
            /Interface '\d+'/,
            `${plane}: no garbage type name read from unrelated source text\n${output}`
        )
    }
})

it("tsserver reports the mixin member type conflict on the consumer and keeps answering", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: source } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<{ start?: { line: number }, code?: number, text?: string }[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                source,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const rendered    = JSON.stringify(diagnostics, undefined, 2)

        t.true(diagnostics.length > 0, `the editor reports the conflict\n${rendered}`)

        t.eq(
            diagnostics.filter((diagnostic) => diagnostic.start?.line === unrelatedLine),
            [],
            `nothing is reported on the unrelated \`const x = 15\` line ${unrelatedLine}\n${rendered}`
        )

        t.true(
            diagnostics.some((diagnostic) => diagnostic.start?.line === consumerLine),
            `the conflict is reported on the consumer's own line ${consumerLine}\n${rendered}`
        )

        t.notMatch(rendered, /Interface '\d+'/, `no garbage type name in the editor\n${rendered}`)

        // The editor must keep working around the conflict: quickinfo on the consumer's
        // `super.print()` call answers instead of crashing the server.
        const superLine   = sourceLines.findIndex((line, index) => index + 1 > consumerLine && line.includes("super.print()")) + 1
        const superOffset = sourceLines[superLine - 1]!.indexOf("print()") + 1
        const quickinfo   = await runTypeScriptServerRequest(
            fixture.directory,
            sourceFile,
            source,
            "quickinfo",
            { file: sourceFile, line: superLine, offset: superOffset }
        )

        t.true(quickinfo.success, `quickinfo on \`super.print()\` answers\n${JSON.stringify(quickinfo, undefined, 2)}`)
    } finally {
        await fixture.dispose()
    }
})
