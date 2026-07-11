import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

// GENERIC required bases across a package boundary (REVIEW.md item 1). The published
// `RuntimeMixinClass<Base>` marker erases forwarded type parameters to `any`, but the
// published `interface M<T> extends Base<T>` retains the full parameter mapping — the
// resolver recovers the constraint from there, so use-site instantiation works through
// `.d.ts` exactly as it does in-program. The characterization probe (2026-07-11) showed
// the pre-fix state: a generic consumer of a declarations-only mixin was REJECTED with
// garbage (TS2314 "requires 1 type argument(s)" from a bare `Mixin$requiredBase` alias,
// TS2507/TS2508 fallout), a valid explicit base failed emit with a false TS2344, and a
// concrete mismatch was invisible in source view.

// Same shape as source-transform-cross-package-linearization.t.ts: build a library
// through the transformer (emit + declarations) and re-root its `dist` under
// `node_modules/<packageName>/`, so a separate program consumes it as a published
// package — through generated `.d.ts` only, never the source.
async function buildDeclarationPackage(
    t: Test,
    packageName: string,
    libraryFiles: TypeScriptFixtureSourceFile[],
    dependencyPackages: TypeScriptFixtureSourceFile[] = []
): Promise<TypeScriptFixtureSourceFile[]> {
    const library = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : libraryFiles,
        extraFiles             : dependencyPackages
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", library.tsconfigFile ], library.directory)

        t.isStrict(build.exitCode, 0, `Package "${packageName}" compiles on its own:\n${commandOutput(build)}`)

        const distDirectory = path.join(library.directory, "dist")
        const emittedNames  = await readdir(distDirectory)
        const emitted       = await Promise.all(emittedNames.map(async (name) => ({
            fileName : `node_modules/${packageName}/${name}`,
            text     : await readFile(path.join(distDirectory, name), "utf8")
        })))

        const exportsMap: Record<string, { types: string, default: string }> = {}

        for (const name of emittedNames) {
            if (name.endsWith(".js")) {
                const stem = name.slice(0, -3)

                exportsMap[`./${stem}`] = { types: `./${stem}.d.ts`, default: `./${stem}.js` }
            }
        }

        return [
            {
                fileName : `node_modules/${packageName}/package.json`,
                text     : JSON.stringify(
                    { name: packageName, version: "0.0.0", type: "module", exports: exportsMap },
                    null,
                    4
                )
            },
            ...emitted
        ]
    } finally {
        await library.dispose()
    }
}

let packageFilesCache: TypeScriptFixtureSourceFile[] | undefined

// One published package shared by every case below (built once per run).
async function genericBasesPackage(t: Test): Promise<TypeScriptFixtureSourceFile[]> {
    // eslint-disable-next-line align-assignments/align-assignments
    packageFilesCache ??= await buildDeclarationPackage(t, "generic-bases", [
        {
            fileName : "lib.ts",
            text     : trimIndent(`
                import { mixin } from "ts-mixin-class"

                export class GenericRoot<U> {
                    root!: U

                    rootTag(): string {
                        return "root"
                    }
                }

                export class GenericMid<T> extends GenericRoot<T[]> {
                    mid!: T
                }

                @mixin()
                export class NeedsMid<T> extends GenericMid<T> {
                    fromMid(): string {
                        return this.rootTag()
                    }
                }

                @mixin()
                export class NeedsRoot<T> extends GenericRoot<T[]> {
                    fromRoot(): string {
                        return this.rootTag()
                    }
                }
            `)
        }
    ])

    return packageFilesCache
}

type BuildResults = {
    emit       : CommandResult,
    sourceView : CommandResult,
    runtime    : CommandResult | undefined,
    emittedJs  : string | undefined
}

async function consume(t: Test, consumerText: string, run = false): Promise<BuildResults> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : await genericBasesPackage(t),
        sourceFiles            : [ { fileName: "consumer.ts", text: trimIndent(consumerText) } ]
    })

    try {
        const emit       = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceView = await runCommand(
            "node",
            [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const runtime    = run && emit.exitCode === 0
            ? await runCommand("node", [ path.join("dist", "consumer.js") ], fixture.directory)
            : undefined
        const emittedJs  = emit.exitCode === 0
            ? await readFile(path.join(fixture.directory, "dist", "consumer.js"), "utf8")
            : undefined

        return { emit, sourceView, runtime, emittedJs }
    } finally {
        await fixture.dispose()
    }
}

it("plans the most-specific generic required base across a package boundary", async (t: Test) => {
    const results = await consume(
        t,
        `
        import { GenericMid, GenericRoot, NeedsMid, NeedsRoot } from "generic-bases/lib"

        class Consumer<V> implements NeedsMid<V>, NeedsRoot<V> {
        }

        const consumer = new Consumer<string>()

        if (!(consumer instanceof GenericMid)) throw new Error("the most-specific cross-package base was not selected")
        if (!(consumer instanceof GenericRoot)) throw new Error("the cross-package base ancestry was not preserved")
        if (consumer.fromMid() !== "root") throw new Error("the mid layer is broken")
        if (consumer.fromRoot() !== "root") throw new Error("the root layer is broken")
    `,
        true
    )

    t.equal(results.emit.exitCode, 0, `emit succeeds.\n${commandOutput(results.emit)}`)
    t.equal(results.sourceView.exitCode, 0, `source view succeeds.\n${commandOutput(results.sourceView)}`)
    t.equal(results.runtime?.exitCode, 0, `runtime succeeds.\n${commandOutput(results.runtime!)}`)
    t.match(
        results.emittedJs ?? "",
        '"verify", 1)',
        "the most-specific cross-package base (NeedsMid, index 1) is planned — no runtime scan"
    )
})

it("rejects incompatible concrete instantiations of cross-package generic bases with TS990013", async (t: Test) => {
    const results = await consume(t, `
        import { NeedsMid, NeedsRoot } from "generic-bases/lib"

        export class Broken implements NeedsMid<string>, NeedsRoot<number> {
        }
    `)

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: incompatible cross-package instantiations are rejected`)
        t.match(output, "TS990013", `${plane}: reports the required-base conflict natively.\n${output}`)
        t.match(output, "Incompatible mixin required bases", `${plane}: explains the conflict.\n${output}`)
        t.match(output, "string", `${plane}: names the left instantiation.\n${output}`)
        t.match(output, "number", `${plane}: names the right instantiation.\n${output}`)
    }
})

it("rejects a concrete explicit base mismatching cross-package use-site arguments in both planes", async (t: Test) => {
    const results = await consume(t, `
        import { GenericRoot, NeedsRoot } from "generic-bases/lib"

        export class Bad extends GenericRoot<number[]> implements NeedsRoot<string> {
        }
    `)

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: the mismatched instantiation is rejected`)
        t.match(output, "Mixin required base mismatch", `${plane}: reports the mismatch.\n${output}`)
        t.match(output, "GenericRoot<string[]>", `${plane}: names the instantiated requirement.\n${output}`)
    }
})

it("accepts a valid explicit generic base of a cross-package mixin in both planes", async (t: Test) => {
    const results = await consume(t, `
        import { GenericRoot, NeedsRoot } from "generic-bases/lib"

        export class Holder<V> extends GenericRoot<V[]> implements NeedsRoot<V> {
        }
    `)

    t.equal(results.emit.exitCode, 0, `emit accepts the matching generic base.\n${commandOutput(results.emit)}`)
    t.equal(results.sourceView.exitCode, 0, `source view accepts it.\n${commandOutput(results.sourceView)}`)
})

// A BASE-LESS published middle mixin (`@mixin Outer<T> implements NeedsMid<T>`, its own
// package) must compose its generic dependency's constraint transitively: the consumer of
// Outer<string> two packages away still plans GenericMid and rejects a wrong explicit base.
it("composes generic constraints through a base-less published middle mixin", async (t: Test) => {
    const outerPackage = await buildDeclarationPackage(
        t,
        "generic-outer",
        [
            {
                fileName : "outer.ts",
                text     : trimIndent(`
                    import { mixin } from "ts-mixin-class"
                    import { NeedsMid } from "generic-bases/lib"

                    @mixin()
                    export class Outer<T> implements NeedsMid<T> {
                        outer(): string {
                            return this.fromMid()
                        }
                    }
                `)
            }
        ],
        await genericBasesPackage(t)
    )

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : [ ...await genericBasesPackage(t), ...outerPackage ],
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : trimIndent(`
                    import { GenericMid, GenericRoot } from "generic-bases/lib"
                    import { Outer } from "generic-outer/outer"

                    class Consumer implements Outer<string> {
                    }

                    const consumer = new Consumer()

                    if (!(consumer instanceof GenericMid)) throw new Error("the transitive cross-package base was not applied")
                    if (!(consumer instanceof GenericRoot)) throw new Error("the transitive ancestry was not preserved")
                    if (consumer.outer() !== "root") throw new Error("the composed layers are broken")
                `)
            }
        ]
    })

    try {
        const emit       = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceView = await runCommand(
            "node",
            [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.equal(emit.exitCode, 0, `emit succeeds.\n${commandOutput(emit)}`)
        t.equal(sourceView.exitCode, 0, `source view succeeds.\n${commandOutput(sourceView)}`)

        if (emit.exitCode === 0) {
            const runtime = await runCommand("node", [ path.join("dist", "consumer.js") ], fixture.directory)

            t.equal(runtime.exitCode, 0, `runtime succeeds.\n${commandOutput(runtime)}`)
        }
    } finally {
        await fixture.dispose()
    }
})

it("accepts a cross-package generic mixin applied over the consumer's own parameter without leaks", async (t: Test) => {
    // The undecidable-at-compile-time shape (a free consumer parameter meeting a concrete
    // sibling instantiation) may keep structural checker errors, but never the bare-alias
    // garbage (TS2314 "requires N type argument(s)" / TS2507 / false TS2344).
    const results = await consume(t, `
        import { NeedsMid, NeedsRoot } from "generic-bases/lib"

        export class Undecidable<V> implements NeedsMid<V>, NeedsRoot<string> {
        }
    `)

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.notMatch(output, "requires 1 type argument", `${plane}: no bare generic alias leaks.\n${output}`)
        t.notMatch(output, "TS2507", `${plane}: no constructor-type fallout.\n${output}`)
        t.notMatch(output, "does not satisfy the constraint 'never'", `${plane}: no malformed validation.\n${output}`)
    }
})
