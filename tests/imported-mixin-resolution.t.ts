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
    t.match(
        consumerJs,
        `__mixinChainLinearized__(undefined, [${localName}], [[0, 0, 1]], "verify", 0)`,
        `${label}: the resolved mixin is applied over Service's Empty-rooted factual base.\n--- consumer.js ---\n${consumerJs}`
    )
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
    t.match(
        consumerJs,
        "__mixinChainLinearized__(undefined, [WidgetA]",
        `the first consumer applies the first file's mixin.\n--- consumer.js ---\n${consumerJs}`
    )
    t.match(
        consumerJs,
        "__mixinChainLinearized__(undefined, [WidgetB]",
        "the second consumer applies the second file's mixin"
    )
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
    t.match(
        consumerJs,
        "__mixinChainLinearized__(undefined, [Alpha, Beta]",
        `the consumer applies both mixins from the circular pair.\n--- consumer.js ---\n${consumerJs}`
    )
})

// A QUALIFIED heritage reference through a NAMESPACE import (`import * as lib` +
// `implements lib.Logger`): the reference resolves through the namespace binding to the
// declaring module's registry entry, and the generated machinery references the value as
// `lib.Logger` (a property access, not a local identifier) on both planes.
it("resolves a mixin referenced through a NAMESPACE import (implements lib.Logger)", async (t: Test) => {
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
    t.match(
        consumerJs,
        "__mixinChainLinearized__(undefined, [lib.Logger]",
        `the qualified mixin is applied through the runtime chain.\n--- consumer.js ---\n${consumerJs}`
    )
})

// The local-namespace form: a TOP-LEVEL namespace exposes its EXPORTED `@mixin` members
// under qualified names — the derived ref's value expression is the dotted access
// (`NS.Tagger`), valid both inside the namespace and outside it.
it("resolves a mixin declared in a local NAMESPACE (implements NS.Tagger)", async (t: Test) => {
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

// A TYPE-ONLY namespace import (`import type * as lib`): the namespace object is erased from
// JS, so the qualified value reference cannot ride on it — the transform routes the value
// through a GENERATED value import (`import { Logger as __lib$Logger$mixinValue }`), exactly
// as it does for a type-only NAMED import. Pins the `binding.typeOnly` branch of
// `addQualifiedMixinRefs`, which no other test exercised.
it("routes a TYPE-ONLY namespace import's value through a generated import (import type * as lib)", async (t: Test) => {
    const { result, consumerJs } = await build([
        { fileName: "logger.ts", text: loggerMixin },
        { fileName : "consumer.ts", text     : trimIndent(`
            import type * as lib from "./logger"

            export class Service implements lib.Logger {
                record(): void { super.log("a") }
                get count(): number { return this.logged.length }
            }
        `) }
    ])

    t.equal(result.exitCode, 0, `type-only namespace-qualified reference compiles.\n${commandOutput(result)}`)
    t.match(
        consumerJs,
        `import { Logger as __lib$Logger$mixinValue } from "./logger"`,
        `the value rides through a generated import, not the erased namespace.\n--- consumer.js ---\n${consumerJs}`
    )
    t.match(consumerJs, "[__lib$Logger$mixinValue]", "the generated value name is used in the chain")
})

// TWO namespace imports exposing the SAME member name (`libA.Widget` / `libB.Widget`): each
// qualified reference must resolve through ITS OWN namespace binding to the right declaring
// module — the dotted key (`libA.Widget` vs `libB.Widget`) keeps them distinct, so neither
// consumer collapses onto the other's mixin (the qualified twin of the same-named §10.14).
it("resolves two namespace imports exposing the SAME member name to their own modules", async (t: Test) => {
    const widget = (marker: string): string => trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class Widget {
            ${marker}(): string { return "${marker}" }
        }
    `)

    const { result, consumerJs } = await build([
        { fileName: "widget-a.ts", text: widget("a") },
        { fileName: "widget-b.ts", text: widget("b") },
        { fileName : "consumer.ts", text     : trimIndent(`
            import * as libA from "./widget-a"
            import * as libB from "./widget-b"

            export class UsesA implements libA.Widget {
                ownA(): string { return super.a() }
            }

            export class UsesB implements libB.Widget {
                ownB(): string { return super.b() }
            }
        `) }
    ])

    t.equal(result.exitCode, 0, `same-named members from two namespaces compile.\n${commandOutput(result)}`)
    t.match(
        consumerJs,
        "__mixinChainLinearized__(undefined, [libA.Widget]",
        `the first consumer applies libA's Widget.\n--- consumer.js ---\n${consumerJs}`
    )
    t.match(
        consumerJs,
        "__mixinChainLinearized__(undefined, [libB.Widget]",
        "the second consumer applies libB's Widget"
    )
})

// A THREE-level qualified name (`Outer.Inner.Deep`) is NOT resolved — only the two-level
// `ns.Member` form is supported (deeper chains would need nested-namespace modelling). The
// boundary must DEGRADE GRACEFULLY: the consumer is left untransformed, so plain TypeScript
// reports the ordinary incorrect-`implements` error (TS2420) — never a crash, never a broken
// half-transform.
it("degrades gracefully on a three-level qualified name (no crash, plain TS2420)", async (t: Test) => {
    const { result } = await build([
        { fileName : "consumer.ts", text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            namespace Outer {
                export namespace Inner {
                    @mixin()
                    export class Deep {
                        deep(): string { return "deep" }
                    }
                }
            }

            export class Service implements Outer.Inner.Deep {
                use(): string { return this.deep() }
            }
        `) }
    ])

    t.ne(result.exitCode, 0, `an unresolved three-level name is a plain type error.\n${commandOutput(result)}`)
    t.match(commandOutput(result), "TS2420", "reports the ordinary incorrect-implements error, no crash")
})

// A CONSTRUCTION-base mixin referenced through a namespace import (§10.1d × §7): the consumer
// extends Base and implements `lib.Ticket`, staying construction-enabled — the qualified
// mixin's required config key flows into the consumer's generated `.new`, and the runtime
// chain references the value as `lib.Ticket`.
it("keeps a construction consumer of a namespace-qualified mixin construction-enabled", async (t: Test) => {
    const { result, consumerJs } = await build([
        { fileName : "ticket.ts", text     : trimIndent(`
            import { Base, mixin } from "ts-mixin-class"

            @mixin()
            export class Ticket extends Base {
                public label!: string
            }
        `) },
        { fileName : "consumer.ts", text     : trimIndent(`
            import { Base } from "ts-mixin-class"
            import * as lib from "./ticket"

            export class Order extends Base implements lib.Ticket {
                public priority: number = 1
            }

            export const order = Order.new({ label: "hot", priority: 2 })

            // @ts-expect-error the required 'label' config key flows in from the qualified mixin
            export const bad = Order.new({ priority: 2 })
        `) }
    ])

    t.equal(result.exitCode, 0, `construction × namespace-qualified mixin compiles.\n${commandOutput(result)}`)
    t.match(consumerJs, "lib.Ticket", `the chain references the qualified construction mixin.\n--- consumer.js ---\n${consumerJs}`)
})
