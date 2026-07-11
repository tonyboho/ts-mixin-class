import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"

async function compileFiles(
    sourceFiles: Array<{ fileName: string, text: string }>,
    compilerOptions: Record<string, unknown>
): Promise<Awaited<ReturnType<typeof runCommand>>> {
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

it("transforms a .tsx source file without disturbing JSX", async (t: Test) => {
    const result = await compileFiles(
        [ {
            fileName : "source.tsx",
            text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            declare global {
                namespace JSX {
                    interface IntrinsicElements { div: { title?: string } }
                }
            }

            @mixin()
            class Renderable {
                renderText(): string { return "rendered" }
            }

            class View implements Renderable {
            }

            const element = <div title={new View().renderText()} />

            void element
        `)
        } ],
        { jsx: "Preserve" }
    )

    t.equal(result.exitCode, 0, `.tsx + JSX compiles through the transformer.\n${commandOutput(result)}`)
})

it("transforms native .mts and .cts module files", async (t: Test) => {
    const mts = await compileFiles(
        [ {
            fileName : "source.mts",
            text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            class M { value: string = "mts" }
            class C implements M {}

            export const value: string = new C().value
        `)
        } ],
        { module: "NodeNext", moduleResolution: "NodeNext" }
    )

    t.equal(mts.exitCode, 0, `.mts compiles through NodeNext.\n${commandOutput(mts)}`)

    const cts = await compileFiles(
        [ {
            fileName : "source.cts",
            text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            class M { value: string = "cts" }
            class C implements M {}

            export const value: string = new C().value
        `)
        } ],
        { module: "CommonJS", moduleResolution: "Node", ignoreDeprecations: "6.0" }
    )

    t.equal(cts.exitCode, 0, `.cts compiles through NodeNext/CommonJS emit.\n${commandOutput(cts)}`)
})

it("resolves a mixin through a tsconfig paths alias", async (t: Test) => {
    const result = await compileFiles(
        [
            {
                fileName : "mixins/logger.ts",
                text     : trimIndent(`
                import { mixin } from "ts-mixin-class"

                @mixin()
                export class Logger {
                    log(): string { return "logged" }
                }
            `)
            },
            {
                fileName : "consumer.ts",
                text     : trimIndent(`
                import { Logger } from "@mixins/logger"

                class Consumer implements Logger {}

                const logged: string = new Consumer().log()

                void logged
            `)
            }
        ],
        {
            baseUrl            : ".",
            ignoreDeprecations : "6.0",
            paths              : { "@mixins/*": [ "mixins/*" ] }
        }
    )

    t.equal(result.exitCode, 0, `paths aliases participate in registry resolution.\n${commandOutput(result)}`)
})

it("builds a declaration-mixin producer and consumer through tsc -b project references", async (t: Test) => {
    const transformPlugin = { transform: "ts-mixin-class", transformProgram: true }
    const fixture         = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "lib/mixin.ts",
                text     : trimIndent(`
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class Shared {
                        shared(): string { return "shared" }
                    }
                `)
            },
            {
                fileName : "app/app.ts",
                text     : trimIndent(`
                    import { Shared } from "../lib/dist/mixin.js"

                    export class App implements Shared {}

                    export const result: string = new App().shared()
                `)
            }
        ],
        extraFiles : [
            {
                fileName : "lib/tsconfig.json",
                text     : JSON.stringify(
                    {
                        compilerOptions : {
                            target           : "ES2022",
                            module           : "ESNext",
                            moduleResolution : "Bundler",
                            strict           : true,
                            skipLibCheck     : true,
                            composite        : true,
                            declaration      : true,
                            rootDir          : ".",
                            outDir           : "dist",
                            plugins          : [ transformPlugin ]
                        },
                        files : [ "mixin.ts" ]
                    },
                    null,
                    4
                )
            },
            {
                fileName : "app/tsconfig.json",
                text     : JSON.stringify(
                    {
                        compilerOptions : {
                            target           : "ES2022",
                            module           : "ESNext",
                            moduleResolution : "Bundler",
                            strict           : true,
                            skipLibCheck     : true,
                            composite        : true,
                            rootDir          : ".",
                            outDir           : "dist",
                            plugins          : [ transformPlugin ]
                        },
                        references : [ { path: "../lib" } ],
                        files      : [ "app.ts" ]
                    },
                    null,
                    4
                )
            },
            {
                fileName : "solution.json",
                text     : JSON.stringify(
                    {
                        files      : [],
                        references : [ { path: "./lib" }, { path: "./app" } ]
                    },
                    null,
                    4
                )
            }
        ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-b", "solution.json" ],
            fixture.directory
        )

        t.equal(result.exitCode, 0, `project-reference build resolves the emitted declaration mixin.\n${commandOutput(result)}`)
    } finally {
        await fixture.dispose()
    }
})
