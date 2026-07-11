import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"

const source = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Root {
        trace(): string { return "root" }
    }

    @mixin()
    class Left implements Root {
        override trace(): string { return "left/" + super.trace() }
    }

    @mixin()
    class Right implements Root {
        override trace(): string { return "right/" + super.trace() }
    }

    class Diamond implements Left, Right {
    }

    console.log(new Diamond().trace())
`)

async function buildMode(
    environment: Record<string, string>
): Promise<{ emit: Awaited<ReturnType<typeof runCommand>>, js: string, run?: Awaited<ReturnType<typeof runCommand>> }> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: source } ]
    })

    try {
        const assignments = Object.entries(environment).map(([ name, value ]) => `${name}=${value}`)
        const emit        = await runCommand(
            "env",
            [ ...assignments, "node", path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const js          = emit.exitCode === 0
            ? await readFile(path.join(fixture.directory, "dist", "source.js"), "utf8")
            : ""
        const run         = emit.exitCode === 0
            ? await runCommand("node", [ path.join("dist", "source.js") ], fixture.directory)
            : undefined

        return { emit, js, run }
    } finally {
        await fixture.dispose()
    }
}

it("TS_MIXIN_VERIFY_LINEARIZATION=0 bakes replay into emitted calls and preserves runtime C3", async (t: Test) => {
    const result = await buildMode({ TS_MIXIN_VERIFY_LINEARIZATION: "0" })

    t.equal(result.emit.exitCode, 0, `replay-mode transform compiles.\n${commandOutput(result.emit)}`)
    t.match(result.js, '"replay"', `the mode is baked into generated helper calls.\n${result.js}`)
    t.notMatch(result.js, '"verify"', "the production mode does not retain the verify selector")
    t.equal(result.run?.exitCode, 0, `replay-mode output runs.\n${result.run === undefined ? "" : commandOutput(result.run)}`)
    t.equal(result.run?.stdout.trim(), "left/right/root", "the replayed plan keeps the C3 method order")
})

it("TS_MIXIN_DISABLE_LINEARIZATION_PLAN=1 bakes c3 into emitted calls and ignores plans at runtime", async (t: Test) => {
    const result = await buildMode({ TS_MIXIN_DISABLE_LINEARIZATION_PLAN: "1" })

    t.equal(result.emit.exitCode, 0, `c3-mode transform compiles.\n${commandOutput(result.emit)}`)
    t.match(result.js, '"c3"', `the escape-hatch mode is baked into generated helper calls.\n${result.js}`)
    t.equal(result.run?.exitCode, 0, `c3-mode output runs.\n${result.run === undefined ? "" : commandOutput(result.run)}`)
    t.equal(result.run?.stdout.trim(), "left/right/root", "runtime C3 produces the same method order")
})
