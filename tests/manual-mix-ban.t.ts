import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

// Manual `.mix(...)` on a PROGRAM-LOCAL mixin is banned (native TS990012, both planes).
// Inside a transformer program mixins compose through the class heritage
// (`extends Base implements Mixin`); the `.mix` method exists on emitted values for
// EXTERNAL (non-transformer) consumers of the package's declarations, where the
// transformer's generated types are not available. A program-local `.mix` bypasses
// construction tracking and rides on synthetic types that cannot support navigation,
// so it is rejected with a clean native diagnostic instead.
//
// The allowed side of the boundary — `.mix` on a mixin imported from a `.d.ts`
// package — is pinned by the declaration-fixture-suite (`package-manual-mix*.t.ts`),
// whose program has the transformer active and composes imported mixins via `.mix`.

async function buildBothPlanes(
    sourceFiles: TypeScriptFixtureSourceFile[]
): Promise<{ emit: CommandResult, sourceView: CommandResult }> {
    const run = async (compilerOptions: Record<string, unknown> | undefined): Promise<CommandResult> => {
        const fixture = await createTypeScriptFixture({
            experimentalDecorators : false,
            compilerOptions,
            sourceFiles
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

    return {
        emit       : await run(undefined),
        sourceView : await run({ noEmit: true })
    }
}

const sameFileMix: TypeScriptFixtureSourceFile[] = [
    {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            class Logger {
                log(message: string): string {
                    return message
                }
            }

            class Custom {
                c: number = 1
            }

            class App extends Logger.mix(Custom) {
            }

            void App
        `)
    }
]

it("a manual .mix of a SAME-FILE mixin is rejected with TS990012 — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(sameFileMix)

    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: the program-local manual .mix is rejected")
    t.match(emitOutput, "TS990012", `…with the native ban diagnostic.\n${emitOutput}`)
    t.match(emitOutput, "source.ts(14", "…anchored on the user's own .mix heritage line")
    t.match(emitOutput, "implements Logger", "…and the message states the heritage fix")

    const sourceViewOutput = commandOutput(sourceView)

    t.ne(sourceView.exitCode, 0, "source view: rejected identically")
    t.match(sourceViewOutput, "TS990012", `both planes agree on the ban code.\n${sourceViewOutput}`)
    t.match(sourceViewOutput, "source.ts(14", "…at the same line")
})

// The `const K = Mixin.mix(Base)` shape (the old dynamic-base workaround) is the same
// program-local application — banned identically, anchored on the `.mix` access.
const constMix: TypeScriptFixtureSourceFile[] = [
    {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            class Tagged {
                tag(value: string): string {
                    return "[" + value + "]"
                }
            }

            class Point {
                x: number = 0
            }

            const TaggedPoint = Tagged.mix(Point)

            void TaggedPoint
        `)
    }
]

it("a manual .mix assigned to a const is rejected the same way — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(constMix)

    for (const [ label, result ] of [ [ "emit", emit ], [ "source view", sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${label}: the const-assigned program-local .mix is rejected`)
        t.match(output, "TS990012", `${label}: the native ban diagnostic.\n${output}`)
        t.match(output, "source.ts(14", `${label}: anchored on the .mix access line`)
    }
})

// CROSS-FILE inside the program: the mixin is imported from another PROGRAM source
// file (not a .d.ts) — still program-local, still banned.
const crossFileMix: TypeScriptFixtureSourceFile[] = [
    {
        fileName : "logger.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            export class Logger {
                log(message: string): string {
                    return message
                }
            }
        `)
    },
    {
        fileName : "source.ts",
        text     : trimIndent(`
            import { Logger } from "./logger"

            class Custom {
                c: number = 1
            }

            class App extends Logger.mix(Custom) {
            }

            void App
        `)
    }
]

it("a manual .mix of a mixin imported from another PROGRAM file is rejected — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(crossFileMix)

    for (const [ label, result ] of [ [ "emit", emit ], [ "source view", sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${label}: the cross-file program-local .mix is rejected`)
        t.match(output, "TS990012", `${label}: the native ban diagnostic.\n${output}`)
        t.match(output, "source.ts(7", `${label}: anchored on the consumer's .mix line, not the mixin's file`)
    }
})

// The heritage form the transformer DOES support stays clean in the same program —
// the ban targets only the `.mix` application syntax.
const heritageForm: TypeScriptFixtureSourceFile[] = [
    {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            class Logger {
                log(message: string): string {
                    return message
                }
            }

            class Custom {
                c: number = 1
            }

            class App extends Custom implements Logger {
            }

            const app = new App()
            const logged: string = app.log("x")

            void logged
        `)
    }
]

it("the extends+implements composition of the same pair stays clean — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(heritageForm)

    t.equal(emit.exitCode, 0, `emit: the supported heritage form is untouched.\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

const qualifiedAndWrappedMixCases: Array<{ label: string, files: TypeScriptFixtureSourceFile[] }> = [
    {
        label : "namespace import",
        files : [
            {
                fileName : "logger.ts",
                text     : trimIndent(`
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class Logger {
                        log(): string { return "log" }
                    }
                `)
            },
            {
                fileName : "source.ts",
                text     : trimIndent(`
                    import * as lib from "./logger"

                    class Base {}
                    class App extends lib.Logger.mix(Base) {}

                    void App
                `)
            }
        ]
    },
    {
        label : "re-export barrel",
        files : [
            {
                fileName : "logger.ts",
                text     : trimIndent(`
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class Logger {
                        log(): string { return "log" }
                    }
                `)
            },
            { fileName: "barrel.ts", text: `export { Logger } from "./logger"` },
            {
                fileName : "source.ts",
                text     : trimIndent(`
                    import { Logger } from "./barrel"

                    class Base {}
                    class App extends Logger.mix(Base) {}

                    void App
                `)
            }
        ]
    },
    {
        label : "parenthesized local value",
        files : [
            {
                fileName : "source.ts",
                text     : trimIndent(`
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    class Logger {
                        log(): string { return "log" }
                    }

                    class Base {}
                    class App extends (Logger).mix(Base) {}

                    void App
                `)
            }
        ]
    }
]

for (const candidate of qualifiedAndWrappedMixCases) {
    it(`rejects program-local .mix through a ${candidate.label}`, async (t: Test) => {
        const { emit, sourceView } = await buildBothPlanes(candidate.files)

        for (const [ plane, result ] of [ [ "emit", emit ], [ "source view", sourceView ] ] as const) {
            const output = commandOutput(result)

            t.ne(result.exitCode, 0, `${plane}: the wrapped/qualified application is rejected`)
            t.match(output, "TS990012", `${plane}: the native manual-.mix ban is preserved.\n${output}`)
        }
    })
}
