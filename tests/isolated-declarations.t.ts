import { readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

// `isolatedDeclarations: true` — the `tsc` layer. The option demands every export's type be
// written syntactically (no checker inference for the `.d.ts`), and users enable it as "one
// more strict option" — so the generated code must comply: the emitted factory carries an
// explicit return annotation (otherwise every `@mixin` in the program was a TS9007 the user
// cannot fix). What legitimately remains is the option's OWN ban on expression heritage: a
// USER-written `class X extends M.mix(B)` on an EXPORTED class is TS9021 in plain TypeScript
// for any functional mixin pattern — the supported recipe for the external (non-transformer)
// consumer is an annotated const with the package `Mix<typeof M, typeof B>` helper.
//
// The FULL external-emitter scenario of the option is out of reach BY DESIGN (an external
// declaration emitter does not run ts-patch and would emit declarations of the untransformed
// source) — declarations must come from the patched tsc; documented as a limitation.

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

async function build(
    sourceFiles: TypeScriptFixtureSourceFile[],
    compilerOptions?: Record<string, unknown>
): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true, isolatedDeclarations: true, ...compilerOptions },
        sourceFiles
    })

    try {
        return await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)
    } finally {
        await fixture.dispose()
    }
}

async function buildBothPlanes(
    sourceFiles: TypeScriptFixtureSourceFile[]
): Promise<{ emit: CommandResult, sourceView: CommandResult }> {
    const [ emit, sourceView ] = await Promise.all([
        build(sourceFiles),
        build(sourceFiles, { noEmit: true })
    ])

    return { emit, sourceView }
}

const representativeShapes: TypeScriptFixtureSourceFile[] = [
    {
        fileName : "mixins.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            export class Logger {
                prefix: string = "log"

                log(message: string): string {
                    return this.prefix + ":" + message
                }

                static origin(): string {
                    return "logger"
                }
            }

            @mixin()
            class LocalTagger {
                tag: string = "t"
            }

            export class Tagged implements LocalTagger {
            }

            export class Req {
                r: number = 1

                static hello(): string {
                    return "hello"
                }
            }

            @mixin()
            export class Stored extends Req {
                key: string = "k"

                static viaBase(): string {
                    return super.hello()
                }
            }

            @mixin()
            export class Timed implements Logger {
                stamp(message: string): string {
                    return "[t] " + this.log(message)
                }
            }
        `)
    },
    {
        fileName : "construction.ts",
        text     : trimIndent(`
            import { Base, mixin } from "ts-mixin-class"

            @mixin()
            export class Titled extends Base {
                public title: string = ""
            }

            export class Doc extends Base implements Titled {
                public pages: number = 0
            }

            const doc = Doc.new({ title: "spec", pages: 3 })

            export const total: number = doc.pages
        `)
    },
    {
        fileName : "generic.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            export class Box<T> {
                value!: T

                unwrap(): T {
                    return this.value
                }

                static kind(): string {
                    return "box"
                }
            }

            export class StringBox implements Box<string> {
            }
        `)
    },
    {
        fileName : "consumer.ts",
        text     : trimIndent(`
            import { Logger, Stored, Req } from "./mixins.js"

            export class App implements Logger {
            }

            export class Vault extends Req implements Stored {
            }

            const proof: string = new App().log("x") + App.origin()

            export const appProof: string = proof
        `)
    },
    {
        fileName : "themed.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            export default class Themed {
                theme: string = "dark"
            }
        `)
    }
]

it("representative mixin shapes build cleanly under isolatedDeclarations — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(representativeShapes)

    t.equal(emit.exitCode, 0, `emit: no TS9007 on generated factories, no other TS90xx.\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

const manualMixHeritage: TypeScriptFixtureSourceFile[] = [
    {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            export class Logger {
                log(message: string): string {
                    return message
                }
            }

            export class Custom {
                c: number = 1
            }

            export class App extends Logger.mix(Custom) {
            }
        `)
    }
]

it("a USER's manual .mix heritage on an EXPORTED class is rejected by the TS990012 ban — both planes", async (t: Test) => {
    // Program-local `.mix` is banned outright (TS990012, `manual-mix-ban.t.ts`), so under
    // `isolatedDeclarations` the ban FRONTS what used to surface as the option's own TS9021
    // (expression heritage). The pin here: the ban lands on the user's heritage line on both
    // planes, and the factory itself stays annotated (no TS9007 noise).
    const { emit, sourceView } = await buildBothPlanes(manualMixHeritage)

    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: the program-local manual .mix heritage is rejected")
    t.match(emitOutput, "TS990012", `the native ban diagnostic.\n${emitOutput}`)
    t.match(emitOutput, "source.ts(14", "…on the user's own heritage line")
    t.notMatch(emitOutput, "TS9007", "…and the factory itself is annotated (no TS9007)")

    const sourceViewOutput = commandOutput(sourceView)

    t.ne(sourceView.exitCode, 0, "source view: rejected identically")
    t.match(sourceViewOutput, "TS990012", `both planes agree.\n${sourceViewOutput}`)
    t.match(sourceViewOutput, "source.ts(14", "…at the same line")
})

// The EXTERNAL (non-transformer) consumer path: the library is built through the transformer
// (emit + declarations), re-rooted under node_modules, and the consumer compiles WITHOUT the
// plugin, with isolatedDeclarations of its own — composing through the published `.mix` and
// keeping its class exported via the annotated-const recipe.
it("the Mix<M, B> recipe keeps an external package's exported .mix composition legal under isolatedDeclarations", async (t: Test) => {
    const library = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true, isolatedDeclarations: true },
        sourceFiles            : [ {
            fileName : "logger.ts",
            text     : trimIndent(`
                import { mixin } from "ts-mixin-class"

                @mixin()
                export class Logger {
                    prefix: string = "log"

                    log(message: string): string {
                        return this.prefix + ":" + message
                    }

                    static origin(): string {
                        return "logger"
                    }
                }
            `)
        } ]
    })

    let libraryFiles: TypeScriptFixtureSourceFile[]

    try {
        const libraryBuild = await runCommand("node", [ tscBinary, "-p", library.tsconfigFile ], library.directory)

        t.equal(libraryBuild.exitCode, 0, `the LIBRARY builds under isolatedDeclarations.\n${commandOutput(libraryBuild)}`)

        const distDirectory = path.join(library.directory, "dist")
        const emittedNames  = await readdir(distDirectory)

        libraryFiles = [
            {
                fileName : "node_modules/mixin-lib/package.json",
                text     : JSON.stringify({
                    name    : "mixin-lib",
                    version : "0.0.0",
                    type    : "module",
                    exports : { "./logger": { types: "./logger.d.ts", default: "./logger.js" } }
                })
            },
            ...await Promise.all(emittedNames.map(async (name) => ({
                fileName : `node_modules/mixin-lib/${name}`,
                text     : await readFile(path.join(distDirectory, name), "utf8")
            })))
        ]
    } finally {
        await library.dispose()
    }

    const consumer = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : libraryFiles,
        sourceFiles            : [ {
            fileName : "app.ts",
            text     : trimIndent(`
                import type { Mix } from "ts-mixin-class"
                import { Logger } from "mixin-lib/logger"

                export class Custom {
                    c: number = 1
                }

                // the supported isolatedDeclarations recipe: an ANNOTATED const (checked,
                // unlike an as-assertion) + extends by name
                const AppBase: Mix<typeof Logger, typeof Custom> = Logger.mix(Custom)

                export class App extends AppBase {
                    run(): string {
                        return this.log("x") + this.c + App.origin()
                    }
                }

                export const proof: string = new App().run()
            `)
        } ]
    })

    try {
        // The consumer is a PLAIN TypeScript package: overwrite the fixture tsconfig with a
        // plugin-less one (no ts-patch transformer — the external-package scenario).
        await writeFile(consumer.tsconfigFile, `${JSON.stringify({
            compilerOptions : {
                target                  : "ES2022",
                module                  : "ESNext",
                moduleResolution        : "Bundler",
                lib                     : [ "ES2022", "DOM" ],
                useDefineForClassFields : false,
                skipLibCheck            : true,
                outDir                  : "dist",
                strict                  : true,
                declaration             : true,
                isolatedDeclarations    : true
            },
            files : [ "app.ts" ]
        }, null, 4)}\n`)

        const consumerBuild = await runCommand("node", [ tscBinary, "-p", consumer.tsconfigFile ], consumer.directory)

        t.equal(consumerBuild.exitCode, 0,
            `the plugin-less consumer composes through .mix + the Mix recipe.\n${commandOutput(consumerBuild)}`)

        const emittedDts = await readFile(path.join(consumer.directory, "dist", "app.d.ts"), "utf8")

        t.match(emittedDts, "Mix<typeof Logger, typeof Custom>",
            `the consumer's own .d.ts carries the annotated base.\n${emittedDts}`)
    } finally {
        await consumer.dispose()
    }
})
