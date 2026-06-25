import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

// Cross-file (one program, many modules) counterpart of nontrivial-diamond-linearization:
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
        t.match(run.stdout, "RESULT:Consumer>D>B>C>E>A",
            `Cross-file chain follows C3 order (E interleaved between C and A):\n${run.stdout}`)
    } finally {
        await fixture.dispose()
    }
})
