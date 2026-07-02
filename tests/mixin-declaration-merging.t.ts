import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

// Declaration MERGING against a `@mixin` class. Plain TS allows a class to merge with a
// namespace (static helpers) and with an interface (extra contract members). The transform
// rewrites the class into a `const` + generated interface, which changes what each merge
// partner can do — this file pins the spec for both.

async function build(
    files: TypeScriptFixtureSourceFile[],
    compilerOptions?: Record<string, unknown>
): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : files
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

it("an instantiated namespace merged with a mixin class is diagnosed (TS990009)", async (t: Test) => {
    // A namespace cannot merge with the const the mixin class is rewritten into — the merge
    // would silently lose the namespace exports from the mixin's value type. Diagnosed
    // natively, on the namespace name, in both planes. The supported alternative is pinned in
    // the next test: static members on the mixin.
    const files: TypeScriptFixtureSourceFile[] = [ {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            export class Logger {
                log(): string {
                    return "logged"
                }
            }

            export namespace Logger {
                export function helper(): string {
                    return "helper"
                }
            }

            export class Service implements Logger {
            }
        `)
    } ]

    const emit       = await build(files)
    const sourceView = await build(files, { noEmit: true })

    for (const [ plane, result ] of [ [ "emit", emit ], [ "source-view", sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: the merge is rejected`)
        t.match(output, "TS990009", `${plane}: the native code surfaces.\n${output}`)
        t.match(output, "Namespace Logger merges with mixin class Logger",
            `${plane}: the message names the merged declaration`)
        t.match(output, "static members of the mixin class instead",
            `${plane}: the message points at the supported alternative`)
    }
})

it("a TYPE-ONLY namespace merged with a mixin class stays legal", async (t: Test) => {
    // Qualified TYPE access (`Logger.Level`) needs no value merge, so a namespace holding only
    // types keeps working and is NOT diagnosed.
    const result = await build([ {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            export class Logger {
                level: Logger.Level = "info"

                log(): string {
                    return "logged"
                }
            }

            export namespace Logger {
                export type Level = "info" | "warn"
            }

            export class Service implements Logger {
            }

            const level: Logger.Level = new Service().level

            void level
        `)
    } ])

    t.equal(result.exitCode, 0, `a type-only namespace merge compiles, un-diagnosed.\n${commandOutput(result)}`)
})

it("an interface merged with a mixin class adds TRUSTED members to the mixin type", async (t: Test) => {
    // Plain TS trusts an interface merged with a class: the members join the class type with no
    // runtime backing required. Through the transform the same trust extends down the chain —
    // the generated $base interface inherits the merged member, so a consumer's type carries it
    // WITHOUT being forced to re-declare it (unlike a plain `implements` of the merged
    // interface). This pins that trust semantics.
    const result = await build([ {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            export interface Greeter {
                politeness: number
            }

            @mixin()
            export class Greeter {
                greet(): string {
                    return "hi"
                }
            }

            export class Polite implements Greeter {
                politeness: number = 10
            }

            // The merged member is TRUSTED (inherited through the generated chain), not
            // re-required — mirroring how plain TS trusts a class-interface merge.
            export class Trusting implements Greeter {
            }

            const polite = new Polite()
            const level: number     = polite.politeness
            const words: string     = polite.greet()
            const trusted: number   = new Trusting().politeness

            void [ level, words, trusted ]
        `)
    } ])

    t.equal(result.exitCode, 0,
        `an interface merged with a mixin class compiles; the member joins the type as trusted.\n${commandOutput(result)}`)
})
