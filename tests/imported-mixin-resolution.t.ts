import { readFile } from "node:fs/promises"
import path from "node:path"

import { it, xit } from "@bryntum/siesta/nodejs.js"
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
        compilerOptions        : { declaration: true },
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
    t.match(consumerJs, `__mixinChainLinearized__(__Service$empty, [${localName}], [[0, 0, 1]], "verify")`,
        `${label}: the resolved mixin is applied through the runtime chain.\n--- consumer.js ---\n${consumerJs}`)
}

it("resolves an aliased mixin import (import { Logger as Log })", async (t: Test) => {
    await assertApplied(t, "aliased import", "Log", [
        { fileName: "logger.ts", text: loggerMixin },
        { fileName : "consumer.ts", text     : trimIndent(`
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
        { fileName: "logger.ts", text: loggerMixin },
        { fileName: "barrel.ts", text: `export { Logger } from "./logger"` },
        { fileName: "consumer.ts", text: consumerUsing("./barrel", "Logger") }
    ])
})

it("resolves a mixin imported through an aliased re-export (export { Logger as Renamed })", async (t: Test) => {
    await assertApplied(t, "aliased re-export", "Renamed", [
        { fileName: "logger.ts", text: loggerMixin },
        { fileName: "barrel.ts", text: `export { Logger as Renamed } from "./logger"` },
        { fileName: "consumer.ts", text: consumerUsing("./barrel", "Renamed") }
    ])
})

it("resolves a mixin imported through a star re-export (export * from)", async (t: Test) => {
    await assertApplied(t, "star re-export", "Logger", [
        { fileName: "logger.ts", text: loggerMixin },
        { fileName: "barrel.ts", text: `export * from "./logger"` },
        { fileName: "consumer.ts", text: consumerUsing("./barrel", "Logger") }
    ])
})

it("resolves a default-exported mixin re-exported by name (export { default as Logger })", async (t: Test) => {
    await assertApplied(t, "default passthrough", "Logger", [
        { fileName: "logger.ts", text: defaultLoggerMixin },
        { fileName: "barrel.ts", text: `export { default as Logger } from "./logger"` },
        { fileName: "consumer.ts", text: consumerUsing("./barrel", "Logger") }
    ])
})

it("resolves a mixin imported through a nested (two-level) barrel", async (t: Test) => {
    await assertApplied(t, "nested barrel", "Logger", [
        { fileName: "logger.ts", text: loggerMixin },
        { fileName: "inner.ts", text: `export { Logger } from "./logger"` },
        { fileName: "outer.ts", text: `export { Logger } from "./inner"` },
        { fileName: "consumer.ts", text: consumerUsing("./outer", "Logger") }
    ])
})

it("resolves two SAME-NAMED mixins from different files consumed in one file", async (t: Test) => {
    // Registry keys are per declaring file, but the consumer-side lookup must follow each import
    // binding to ITS declaring module — two same-named mixins must not collapse into one
    // (first-name-wins would apply the wrong mixin to one of the consumers). Each consumer uses a
    // member only its own mixin has, so a crossed application fails to compile.
    const widgetA  = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class Widget {
            a(): string { return "A" }
        }
    `)
    const widgetB  = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class Widget {
            b(): string { return "B" }
        }
    `)
    const consumer = trimIndent(`
        import { Widget as WidgetA } from "./widget-a"
        import { Widget as WidgetB } from "./widget-b"

        export class UsesA implements WidgetA {
            ownA(): string { return super.a() }
        }

        export class UsesB implements WidgetB {
            ownB(): string { return super.b() }
        }
    `)

    const { result, consumerJs } = await build([
        { fileName: "widget-a.ts", text: widgetA },
        { fileName: "widget-b.ts", text: widgetB },
        { fileName: "consumer.ts", text: consumer }
    ])

    t.equal(result.exitCode, 0, `same-named mixins from two files compile.\n${commandOutput(result)}`)
    t.match(consumerJs, "__mixinChainLinearized__(__UsesA$empty, [WidgetA]",
        `the first consumer applies the first file's mixin.\n--- consumer.js ---\n${consumerJs}`)
    t.match(consumerJs, "__mixinChainLinearized__(__UsesB$empty, [WidgetB]",
        "the second consumer applies the second file's mixin")
})

it("resolves mixins across CIRCULARLY importing files", async (t: Test) => {
    // Two mixin files importing each other (a type-level cycle a real project hits): the
    // registry build must not loop or drop either mixin, and consumers on both sides must
    // resolve their imported mixin.
    const alpha    = trimIndent(`
        import { mixin } from "ts-mixin-class"
        import type { Beta } from "./beta"

        @mixin()
        export class Alpha {
            describeOther(other: Beta): string {
                return "alpha-sees:" + other.beta()
            }
        }
    `)
    const beta     = trimIndent(`
        import { mixin } from "ts-mixin-class"
        import { Alpha } from "./alpha"

        @mixin()
        export class Beta {
            beta(): string { return "beta" }
        }

        export class BetaSideConsumer implements Alpha {
        }
    `)
    const consumer = trimIndent(`
        import { Alpha } from "./alpha"
        import { Beta } from "./beta"

        export class Service implements Alpha, Beta {
        }
    `)

    const { result, consumerJs } = await build([
        { fileName: "alpha.ts", text: alpha },
        { fileName: "beta.ts", text: beta },
        { fileName: "consumer.ts", text: consumer }
    ])

    t.equal(result.exitCode, 0, `circularly importing mixin files compile.\n${commandOutput(result)}`)
    t.match(consumerJs, "__mixinChainLinearized__(__Service$empty, [Alpha, Beta]",
        `the consumer applies both mixins from the circular pair.\n--- consumer.js ---\n${consumerJs}`)
})

// SKIPPED (xit) — decided-deferred spec point (see TODO.md "Qualified mixin references").
// A QUALIFIED heritage reference (`implements lib.Logger` via `import * as lib`) is not
// resolved: the consumer is left untransformed and fails with a bare TS2420. Resolution keys
// heritage references by identifier; supporting PropertyAccess needs facts + registry +
// two-plane emission work.
xit("resolves a mixin referenced through a NAMESPACE import (implements lib.Logger)", async (t: Test) => {
    const { result, consumerJs } = await build([
        { fileName: "logger.ts", text: loggerMixin },
        { fileName : "consumer.ts", text     : trimIndent(`
            import * as lib from "./logger"

            export class Service implements lib.Logger {
                record(): void { super.log("a") }
                get count(): number { return this.logged.length }
            }
        `) }
    ])

    t.equal(result.exitCode, 0, `namespace-qualified mixin reference compiles (mixin resolved).\n${commandOutput(result)}`)
    t.match(consumerJs, "__mixinChainLinearized__(__Service$empty, [lib.Logger]",
        `the qualified mixin is applied through the runtime chain.\n--- consumer.js ---\n${consumerJs}`)
})

// SKIPPED (xit) — same deferred spec point as above, the local-namespace form.
xit("resolves a mixin declared in a local NAMESPACE (implements NS.Tagger)", async (t: Test) => {
    const { result } = await build([
        { fileName : "consumer.ts", text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            namespace NS {
                @mixin()
                export class Tagger {
                    tag(): string {
                        return "tagged"
                    }
                }
            }

            export class Service implements NS.Tagger {
                use(): string { return this.tag() }
            }
        `) }
    ])

    t.equal(result.exitCode, 0, `local-namespace-qualified mixin reference compiles (mixin resolved).\n${commandOutput(result)}`)
})
