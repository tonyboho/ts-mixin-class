import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

// CONSUMER ↔ MIXIN feature PARITY. Consumers and mixins take DIFFERENT code paths
// (consumer-expand vs mixin-expand), so a feature verified on the consumer side is not
// automatically alive on the mixin side. Every scenario here has a consumer-side twin that is
// already pinned elsewhere; this file pins the MIXIN-side (a `@mixin` in the consumer role —
// implementing its dependencies — or a mixin standing where a class stood).

async function build(
    sources: string | TypeScriptFixtureSourceFile[],
    compilerOptions?: Record<string, unknown>
): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : typeof sources === "string"
            ? [ { fileName: "source.ts", text: sources } ]
            : sources
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

it("a @mixin implementing a LATER-declared dependency gets the TDZ diagnostic (consumer twin: §1.19)", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Early implements Late {
            early(): string {
                return "e"
            }
        }

        @mixin()
        class Late {
            late(): string {
                return "l"
            }
        }

        void Early
    `)

    const emit       = await build(source)
    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: rejected")
    t.match(emitOutput, "TS990008", `the native TDZ diagnostic fires for a mixin dependency too.\n${emitOutput}`)

    const sourceView = await build(source, { noEmit: true })

    t.match(commandOutput(sourceView), "TS990008", "source view agrees")
})

it("a @mixin resolves a BARREL-imported dependency (consumer twin: §10.1c)", async (t: Test) => {
    const result = await build([
        {
            fileName : "logger.ts",
            text     : trimIndent(`
                import { mixin } from "ts-mixin-class"

                @mixin()
                export class Logger {
                    log(message: string): string {
                        return "[log] " + message
                    }
                }
            `)
        },
        {
            fileName : "barrel.ts",
            text     : "export { Logger } from \"./logger\"\n"
        },
        {
            fileName : "source.ts",
            text     : trimIndent(`
                import { mixin } from "ts-mixin-class"
                import { Logger } from "./barrel"

                @mixin()
                class Loud implements Logger {
                    shout(message: string): string {
                        return this.log(message).toUpperCase()
                    }
                }

                class App implements Loud {
                }

                const app = new App()

                const logged: string  = app.log("x")
                const shouted: string = app.shout("hi")

                void [ logged, shouted ]
            `)
        }
    ])

    t.equal(
        result.exitCode,
        0,
        `the mixin-dependency path resolves through the re-export barrel.\n${commandOutput(result)}`
    )
})

it("a plain class SUBCLASSING a mixin value directly (extends, not implements) type-checks", async (t: Test) => {
    // The consumer twin is §2.3 (a consumer subclassed again). Extending the mixin VALUE rides
    // on its canonical class (the factory applied over the seed base), so the members are
    // present; `implements` stays the composition mechanism, but a direct `extends` must not
    // break.
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Greeter {
            greet(): string {
                return "hi"
            }
        }

        class Sub extends Greeter {
            loud(): string {
                return this.greet() + "!"
            }
        }

        const sub = new Sub()

        const greeted: string    = sub.greet()
        const louder: string     = sub.loud()
        const isGreeter: boolean = sub instanceof Greeter

        void [ greeted, louder, isGreeter ]
    `)

    const emit = await build(source)

    t.equal(emit.exitCode, 0, `emit accepts the direct subclass.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("a construction MIXIN declared in a NESTED scope constructs through .new (consumer twin: §16.7)", async (t: Test) => {
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        export function makeTicket(): { tag: string } {
            @mixin()
            class Ticket extends Base {
                public tag: string = "t"
            }

            return Ticket.new({ tag: "nested" })
        }

        const made: string = makeTicket().tag

        void made
    `)

    const emit = await build(source)

    t.equal(emit.exitCode, 0, `emit: the nested construction mixin gets its .new.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})
