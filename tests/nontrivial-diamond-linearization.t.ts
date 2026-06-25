import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

// Nontrivial diamond linearization through the FULL transformer pipeline (compile + run),
// as opposed to runtime-helper.t.ts which drives the runtime helpers directly. These pin
// the behaviour a precomputed-linearization optimization must preserve: the assembled C3
// order at run time, and the compile-time detection of an inconsistent diamond.

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
        t.match(run.stdout, "RESULT:Consumer>D>B>C>E>A",
            `Assembled chain follows C3 order (E interleaved between C and A):\n${run.stdout}`)
    } finally {
        await fixture.dispose()
    }
})

// A 3-cycle of pairwise orders: P imposes A<B, Q imposes B<C, R imposes C<A. Each pair is
// consistent on its own, so P, Q, R each compile; only a consumer of all three forms the
// cycle A<B<C<A and must be reported as a compile-time C3 conflict.
it("detects a nontrivial 3-cycle linearization conflict at compile time", async (t: Test) => {
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
        const build  = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)
        const output = commandOutput(build)

        t.ne(build.exitCode, 0, `A 3-cycle diamond must fail to compile:\n${output}`)
        t.match(output, "Cannot linearize mixin classes with the C3 algorithm",
            `... with the C3 conflict diagnostic:\n${output}`)
    } finally {
        await fixture.dispose()
    }
})

// A `@mixin` whose OWN dependencies are inconsistent is reported at compile time even with
// no consumer to force the linearization. The source-view / `--noEmit` path reports it on the
// generated `__Z$base` (a never-constrained validation type parameter, like a consumer's
// conflict), so it surfaces in tsserver without stranding a real token in the source view.
it("detects a mixin-only linearization conflict (no consumer) at compile time", async (t: Test) => {
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
        const build  = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)
        const output = commandOutput(build)

        t.ne(build.exitCode, 0, `A mixin-only 3-cycle must fail to compile:\n${output}`)
        t.match(output, "Cannot linearize mixin classes with the C3 algorithm",
            `... with the C3 conflict diagnostic:\n${output}`)
    } finally {
        await fixture.dispose()
    }
})

// The same mixin-only conflict must ALSO fail an emit build (`tsc`, not `--noEmit`), not just
// the source-view / type-check path. Emit has no `__Z$base` carrier, so the transformer
// intersects `MixinLinearizationConflict<"<message>">` into the mixin value's cast; `tsc`
// reports the C3 message there.
it("detects a mixin-only linearization conflict in emit mode (tsc, not --noEmit)", async (t: Test) => {
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
        const build  = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)
        const output = commandOutput(build)

        t.ne(build.exitCode, 0, `A mixin-only 3-cycle must fail an emit build too:\n${output}`)
        t.match(output, "Cannot linearize mixin classes with the C3 algorithm",
            `... with the C3 conflict diagnostic in emit mode:\n${output}`)
    } finally {
        await fixture.dispose()
    }
})
