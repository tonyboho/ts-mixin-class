import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { TypeScriptFixtureSourceFile } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

// Nontrivial diamond linearization through the FULL transformer pipeline (compile + run),
// as opposed to runtime-helper.t.ts which drives the runtime helpers directly. The SAME
// interleaved diamond is pinned at three module topologies — single-file, cross-file and
// cross-package — plus the compile-time detection of an inconsistent diamond. These pin
// the behaviour a precomputed-linearization optimization must preserve: the assembled C3
// order at run time, and the conflict diagnostics.

// Two diamonds share `A`: `D` pulls in `[B, C]` (both over `A`) and the consumer adds `E`
// (also over `A`). C3 delays the shared `A` past `E`, interleaving `E` between `C` and `A`
// -- an order a plain depth-first walk would NOT produce. Each mixin's `who()` prepends its
// name and calls `super.who()`, so the printed string is the exact linearization.
it("preserves the C3 order of a nontrivial diamond through compile-and-run", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    class A {
                        who(): string { return "A" }
                    }

                    @mixin()
                    class B implements A {
                        who(): string { return "B>" + super.who() }
                    }

                    @mixin()
                    class C implements A {
                        who(): string { return "C>" + super.who() }
                    }

                    @mixin()
                    class D implements B, C {
                        who(): string { return "D>" + super.who() }
                    }

                    @mixin()
                    class E implements A {
                        who(): string { return "E>" + super.who() }
                    }

                    class Consumer implements D, E {
                        who(): string { return "Consumer>" + super.who() }
                    }

                    console.log("RESULT:" + new Consumer().who())
                `
            }
        ]
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(build.exitCode, 0, `Nontrivial diamond fixture compiles and emits:\n${commandOutput(build)}`)

        const run = await runCommand("node", [ path.join(fixture.directory, "dist", "consumer.js") ], fixture.directory)

        t.isStrict(run.exitCode, 0, `Emitted consumer runs:\n${commandOutput(run)}`)
        t.match(
            run.stdout,
            "RESULT:Consumer>D>B>C>E>A",
            `Assembled chain follows C3 order (E interleaved between C and A):\n${run.stdout}`
        )
    } finally {
        await fixture.dispose()
    }
})

// Cross-file (one program, many modules) counterpart of the single-file diamond above:
// the interleaved diamond's mixins each live in their own file and import their
// dependencies across module boundaries, so the compiler derives each merge plan against
// imported -- not same-file -- linearizations. Compiling and running the result proves the
// plan's integer offsets still line up with the runtime arrays across files. The runtime
// linearization cross-check is ON BY DEFAULT, so the emitted program also asserts
// replay == C3 for every mixin and the consumer as it runs: a drifted offset would throw
// instead of printing the order.
//
//   A          (a.ts)
//   B = [A]    (b.ts)   C = [A]  (c.ts)   E = [A]  (e.ts)
//   D = [B, C] (d.ts)
//   Consumer = [D, E]   -> C3 delays the shared A past E, interleaving E between C and A.
it("preserves the C3 order of a cross-file nontrivial diamond (compile-and-run, verified)", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "a.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class A {
                        who(): string { return "A" }
                    }
                `
            },
            {
                fileName : "b.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"
                    import { A } from "./a.js"

                    @mixin()
                    export class B implements A {
                        who(): string { return "B>" + super.who() }
                    }
                `
            },
            {
                fileName : "c.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"
                    import { A } from "./a.js"

                    @mixin()
                    export class C implements A {
                        who(): string { return "C>" + super.who() }
                    }
                `
            },
            {
                fileName : "d.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"
                    import { B } from "./b.js"
                    import { C } from "./c.js"

                    @mixin()
                    export class D implements B, C {
                        who(): string { return "D>" + super.who() }
                    }
                `
            },
            {
                fileName : "e.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"
                    import { A } from "./a.js"

                    @mixin()
                    export class E implements A {
                        who(): string { return "E>" + super.who() }
                    }
                `
            },
            {
                fileName : "consumer.ts",
                text     : `
                    import { D } from "./d.js"
                    import { E } from "./e.js"

                    class Consumer implements D, E {
                        who(): string { return "Consumer>" + super.who() }
                    }

                    console.log("RESULT:" + new Consumer().who())
                `
            }
        ]
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(build.exitCode, 0, `Cross-file diamond fixture compiles and emits:\n${commandOutput(build)}`)

        const run = await runCommand("node", [ path.join(fixture.directory, "dist", "consumer.js") ], fixture.directory)

        t.isStrict(run.exitCode, 0, `Emitted cross-file consumer runs (default-on cross-check passes):\n${commandOutput(run)}`)
        t.match(
            run.stdout,
            "RESULT:Consumer>D>B>C>E>A",
            `Cross-file chain follows C3 order (E interleaved between C and A):\n${run.stdout}`
        )
    } finally {
        await fixture.dispose()
    }
})

// Builds a library through the transformer (emit + declarations) and re-roots its emitted
// `dist` under `node_modules/<packageName>/` so a separate program consumes it as a
// published package -- through generated `.d.ts` and the emitted `.js`, never the source.
// `dependencyPackages` carries the declaration+js output of packages this library depends
// on, written to disk (but not recompiled) so the library's own build resolves its
// cross-package imports.
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
                    {
                        name    : packageName,
                        version : "0.0.0",
                        type    : "module",
                        exports : exportsMap
                    },
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

// Cross-PACKAGE counterpart of the cross-file diamond above: the interleaved diamond is
// split across three published packages, and the consumer composes it from their `.d.ts`
// only. The point is the compile-time merge plan -- its integer offsets index into each
// imported mixin's FULL linearization, which the consumer's compiler must reconstruct from
// declarations alone. Compiling AND running the consumer is what gives that a teeth: the
// runtime cross-check is on by default, so if a cross-package offset is wrong the running
// consumer throws instead of printing the order. (The existing cross-package conflict test
// only type-checks, so it cannot catch a wrong offset -- only an actual run can.)
//
//   package "diamond-leaf": A
//   package "diamond-mid":  B = [A], C = [A], E = [A]   (import A from diamond-leaf)
//   package "diamond-top":  D = [B, C]                  (import B, C from diamond-mid)
//   consumer program:       implements D, E  -> Consumer>D>B>C>E>A (E interleaved past A)
it("preserves the C3 order of a cross-package nontrivial diamond (compile-and-run, verified)", async (t: Test) => {
    const leafPackage = await buildDeclarationPackage(t, "diamond-leaf", [
        {
            fileName : "leaf.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                @mixin()
                export class A {
                    who(): string { return "A" }
                }
            `
        }
    ])

    const midPackage = await buildDeclarationPackage(
        t,
        "diamond-mid",
        [
            {
                fileName : "mid.ts",
                text     : `
                import { mixin } from "ts-mixin-class"
                import { A } from "diamond-leaf/leaf"

                @mixin()
                export class B implements A {
                    who(): string { return "B>" + super.who() }
                }

                @mixin()
                export class C implements A {
                    who(): string { return "C>" + super.who() }
                }

                @mixin()
                export class E implements A {
                    who(): string { return "E>" + super.who() }
                }
            `
            }
        ],
        leafPackage
    )

    const topPackage = await buildDeclarationPackage(
        t,
        "diamond-top",
        [
            {
                fileName : "top.ts",
                text     : `
                import { mixin } from "ts-mixin-class"
                import { B, C } from "diamond-mid/mid"

                @mixin()
                export class D implements B, C {
                    who(): string { return "D>" + super.who() }
                }
            `
            }
        ],
        [ ...midPackage, ...leafPackage ]
    )

    const consumerText = `
        import { D } from "diamond-top/top"
        import { E } from "diamond-mid/mid"

        class Consumer implements D, E {
            who(): string { return "Consumer>" + super.who() }
        }

        console.log("RESULT:" + new Consumer().who())
    `

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : [ ...leafPackage, ...midPackage, ...topPackage ],
        sourceFiles            : [ { fileName: "consumer.ts", text: consumerText } ]
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(build.exitCode, 0, `Cross-package diamond consumer compiles:\n${commandOutput(build)}`)

        const run = await runCommand("node", [ path.join(fixture.directory, "dist", "consumer.js") ], fixture.directory)

        t.isStrict(
            run.exitCode,
            0,
            `Emitted cross-package consumer runs (default-on cross-check passes):\n${commandOutput(run)}`
        )
        t.match(
            run.stdout,
            "RESULT:Consumer>D>B>C>E>A",
            `Cross-package chain follows C3 order (E interleaved between C and A):\n${run.stdout}`
        )
    } finally {
        await fixture.dispose()
    }
})

// A 3-cycle of pairwise orders: P imposes A<B, Q imposes B<C, R imposes C<A. Each pair is
// consistent on its own, so P, Q, R each compile; only a consumer of all three forms the
// cycle A<B<C<A and must be reported as a compile-time C3 conflict. The conflict is a NATIVE
// diagnostic (TS990007) surfaced identically in emit (`tsc`) and source-view (`--noEmit`) modes.
it("detects a nontrivial 3-cycle linearization conflict at compile time on both planes", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin() class A {}
                    @mixin() class B {}
                    @mixin() class C {}

                    @mixin() class P implements A, B {}
                    @mixin() class Q implements B, C {}
                    @mixin() class R implements C, A {}

                    class Z implements P, Q, R {}
                `
            }
        ]
    })

    try {
        for (const extraArgs of [ [], [ "--noEmit" ] ]) {
            const build  = await runCommand("node", [ tscBinary, ...extraArgs, "-p", fixture.tsconfigFile ], fixture.directory)
            const output = commandOutput(build)
            const mode   = extraArgs.length === 0 ? "emit" : "--noEmit"

            t.ne(build.exitCode, 0, `A 3-cycle diamond must fail to compile (${mode}):\n${output}`)
            t.match(output, "TS990007", `... as the native C3 conflict diagnostic (${mode}):\n${output}`)
            t.match(
                output,
                "Cannot linearize mixin classes with the C3 algorithm",
                `... with the C3 conflict message (${mode}):\n${output}`
            )
        }
    } finally {
        await fixture.dispose()
    }
})

// A `@mixin` whose OWN dependencies are inconsistent is reported at compile time even with
// no consumer to force the linearization, as a NATIVE diagnostic (TS990007) spanned on the
// mixin's first `implements` entry — so it surfaces in tsserver without stranding a real token
// in the source view, and identically in emit mode (`tsc`, not just `--noEmit`): the native
// diagnostic is pushed before the emit/source-view split.
it("detects a mixin-only linearization conflict (no consumer) at compile time on both planes", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin() class A {}
                    @mixin() class B {}
                    @mixin() class C {}

                    @mixin() class P implements A, B {}
                    @mixin() class Q implements B, C {}
                    @mixin() class R implements C, A {}

                    // No consumer class -- the conflict lives entirely in this mixin's deps.
                    @mixin() class Z implements P, Q, R {}
                `
            }
        ]
    })

    try {
        for (const extraArgs of [ [], [ "--noEmit" ] ]) {
            const build  = await runCommand("node", [ tscBinary, ...extraArgs, "-p", fixture.tsconfigFile ], fixture.directory)
            const output = commandOutput(build)
            const mode   = extraArgs.length === 0 ? "emit" : "--noEmit"

            t.ne(build.exitCode, 0, `A mixin-only 3-cycle must fail to compile (${mode}):\n${output}`)
            t.match(
                output,
                "Cannot linearize mixin classes with the C3 algorithm",
                `... with the C3 conflict diagnostic (${mode}):\n${output}`
            )
        }
    } finally {
        await fixture.dispose()
    }
})
