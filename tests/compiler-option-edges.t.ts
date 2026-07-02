import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// Strict-option edges over the GENERATED surfaces. `verbatimModuleSyntax` is pinned corpus-wide
// (fixture-suite tsconfig) — it guards the injected helper import's type/value split on every
// fixture. `exactOptionalPropertyTypes` gets its pin here: the generated `<Class>Config` is all
// OPTIONAL keys (`name?: T`), and under the option an optional key may be ABSENT but may not be
// explicitly `undefined` — both sides pinned below.

async function build(text: string, compilerOptions?: Record<string, unknown>): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { exactOptionalPropertyTypes: true, ...compilerOptions },
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })

    try {
        return await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
    } finally {
        await fixture.dispose()
    }
}

const constructionSource = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    class Named extends Base {
        public name: string = "unnamed"
    }

    class Widget extends Base implements Named {
        public size!: number
    }

    const widget = Widget.new({ size: 3, name: "w" })
    const bare   = Widget.new({ size: 1 })

    // The config keys are OPTIONAL, and under exactOptionalPropertyTypes optional means
    // "may be absent" — an EXPLICIT undefined is rejected (TS2379/TS2375 family).
    // @ts-expect-error exactOptionalPropertyTypes rejects an explicit undefined config value
    const broken = Widget.new({ size: 2, name: undefined })

    const sized: number = widget.size

    void [ bare, broken, sized ]
`)

it("construction .new config under exactOptionalPropertyTypes (emit)", async (t: Test) => {
    const result = await build(constructionSource)

    t.equal(result.exitCode, 0,
        `optional config keys stay usable; explicit undefined is rejected.\n${commandOutput(result)}`)
})

it("construction .new config under exactOptionalPropertyTypes (source view)", async (t: Test) => {
    const result = await build(constructionSource, { noEmit: true })

    t.equal(result.exitCode, 0, `the source-view plane agrees.\n${commandOutput(result)}`)
})
