import { readFile } from "node:fs/promises"
import path from "node:path"

import { createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// Shared isolated-tsc harness for the construction-config accessor tests. Each of them used to
// redefine this verbatim: compile a single `source.ts` through the transformer (emit, or
// `noEmit` for the source-view plane) and report the result, or read the generated
// `<Class>Config` back out of the emitted `source.d.ts`. Kept as a plain helper (not a `.t.ts`
// file, so siesta does not run it as a test).

export async function buildConstructionSource(
    text: string,
    compilerOptions?: Record<string, unknown>
): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : [ { fileName : "source.ts", text } ]
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

export async function readConstructionConfigDts(text: string): Promise<string> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration : true },
        sourceFiles            : [ { fileName : "source.ts", text } ]
    })

    try {
        await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        return await readFile(path.join(fixture.directory, "dist", "source.d.ts"), "utf8")
    } finally {
        await fixture.dispose()
    }
}
