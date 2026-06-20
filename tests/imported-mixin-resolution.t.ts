import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, trimIndent } from "./util.js"
import { runCommand } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

// How the transformer resolves an imported mixin reference back to its registry entry.
// The registry keys mixins by their DECLARING file; matching a consumer's `implements`
// reference must follow the import — including re-export aliases — to that declaring
// module. These cases cover the import/re-export shapes a real project uses. A consumer
// that fails to resolve is left untransformed and does NOT compile (TS2420/TS2335), so a
// clean compile already proves the mixin was recognized; the emitted `mixinChain(...)`
// confirms it was actually applied under the local binding name.

const loggerMixin = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class Logger {
        public logged: string[] = []

        log(message: string): void {
            this.logged.push(message)
        }
    }
`)

const defaultLoggerMixin = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export default class Logger {
        public logged: string[] = []

        log(message: string): void {
            this.logged.push(message)
        }
    }
`)

// Consumer relies on the INJECTED mixin member (super.log + this.logged), declaring
// neither — so it only compiles if the mixin was actually applied. The local binding name
// is parameterised so each case imports under the name it re-exports.
const consumerUsing = (importSpecifier: string, localName: string): string => trimIndent(`
    import { ${localName} } from "${importSpecifier}"

    export class Service implements ${localName} {
        record(): void {
            super.log("a")
            super.log("b")
        }

        get count(): number {
            return this.logged.length
        }
    }
`)

async function build(files: TypeScriptFixtureSourceFile[]): Promise<{ result: CommandResult, consumerJs: string }> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration : true },
        sourceFiles            : files
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        let consumerJs = ""

        if (result.exitCode === 0) {
            try {
                consumerJs = await readFile(path.join(fixture.directory, "dist", "consumer.js"), "utf8")
            } catch {
                consumerJs = "(no consumer.js emitted)"
            }
        }

        return { result, consumerJs }
    } finally {
        await fixture.dispose()
    }
}

// Asserts the consumer compiled (mixin recognized) and the mixin was applied through the
// runtime chain under its local binding name.
async function assertApplied(t: Test, label: string, localName: string, files: TypeScriptFixtureSourceFile[]): Promise<void> {
    const { result, consumerJs } = await build(files)

    t.equal(result.exitCode, 0, `${label}: the consumer should compile (mixin resolved).\n${commandOutput(result)}`)
    t.match(consumerJs, `mixinChain(__Service$empty, ${localName})`,
        `${label}: the resolved mixin is applied through the runtime chain.\n--- consumer.js ---\n${consumerJs}`)
}

it("resolves an aliased mixin import (import { Logger as Log })", async (t: Test) => {
    await assertApplied(t, "aliased import", "Log", [
        { fileName : "logger.ts", text : loggerMixin },
        { fileName : "consumer.ts", text : trimIndent(`
            import { Logger as Log } from "./logger"

            export class Service implements Log {
                record(): void { super.log("a") }
                get count(): number { return this.logged.length }
            }
        `) }
    ])
})

it("resolves a mixin imported through a named re-export barrel", async (t: Test) => {
    await assertApplied(t, "named barrel", "Logger", [
        { fileName : "logger.ts", text : loggerMixin },
        { fileName : "barrel.ts", text : `export { Logger } from "./logger"` },
        { fileName : "consumer.ts", text : consumerUsing("./barrel", "Logger") }
    ])
})

it("resolves a mixin imported through an aliased re-export (export { Logger as Renamed })", async (t: Test) => {
    await assertApplied(t, "aliased re-export", "Renamed", [
        { fileName : "logger.ts", text : loggerMixin },
        { fileName : "barrel.ts", text : `export { Logger as Renamed } from "./logger"` },
        { fileName : "consumer.ts", text : consumerUsing("./barrel", "Renamed") }
    ])
})

it("resolves a mixin imported through a star re-export (export * from)", async (t: Test) => {
    await assertApplied(t, "star re-export", "Logger", [
        { fileName : "logger.ts", text : loggerMixin },
        { fileName : "barrel.ts", text : `export * from "./logger"` },
        { fileName : "consumer.ts", text : consumerUsing("./barrel", "Logger") }
    ])
})

it("resolves a default-exported mixin re-exported by name (export { default as Logger })", async (t: Test) => {
    await assertApplied(t, "default passthrough", "Logger", [
        { fileName : "logger.ts", text : defaultLoggerMixin },
        { fileName : "barrel.ts", text : `export { default as Logger } from "./logger"` },
        { fileName : "consumer.ts", text : consumerUsing("./barrel", "Logger") }
    ])
})

it("resolves a mixin imported through a nested (two-level) barrel", async (t: Test) => {
    await assertApplied(t, "nested barrel", "Logger", [
        { fileName : "logger.ts", text : loggerMixin },
        { fileName : "inner.ts", text : `export { Logger } from "./logger"` },
        { fileName : "outer.ts", text : `export { Logger } from "./inner"` },
        { fileName : "consumer.ts", text : consumerUsing("./outer", "Logger") }
    ])
})
