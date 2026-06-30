import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"

// A `@mixin` class must NOT `extends` another mixin: a mixin consumes other mixins through
// `implements` (which builds the runtime chain), while `extends` on a mixin is reserved for a
// required (non-mixin) base class. `@mixin class B extends A`, where A is itself a registered
// mixin, must therefore be a compile-time error — and it must be a NATIVE `ts.Diagnostic`
// (authored by the transform, with our own message/code/span), not a type-encoded one.
//
// This is the first error migrated to the native-diagnostic channel, so it is exercised through a
// REAL `tsc` build (which runs the patched program transform + its `getSemanticDiagnostics` wrap),
// not the in-process `transformSourceFile -> printSourceFile -> typecheckText` path that only sees
// type-encoded errors baked into the reprinted text.

const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

it("rejects a `@mixin` class that extends another mixin with a native diagnostic", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { noEmit: true },
        sourceFiles            : [
            {
                fileName : "mixin-a.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class Alpha {
                        alphaValue(): number {
                            return 1
                        }
                    }
                `
            },
            {
                fileName : "mixin-b.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"
                    import { Alpha } from "./mixin-a.js"

                    @mixin()
                    export class Bravo extends Alpha {
                        bravoValue(): number {
                            return 2
                        }
                    }
                `
            }
        ]
    })

    try {
        const result = await runCommand(
            "node",
            [ tscBin, "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, "A `@mixin` extending another mixin fails to build")
        t.match(output, "cannot extend another mixin", "Diagnostic explains a mixin cannot extend a mixin")
        t.match(output, "Bravo", "Diagnostic names the offending mixin")
        t.match(output, "Alpha", "Diagnostic names the extended mixin")
        t.match(output, "implements", "Diagnostic points at the `implements` fix")
        t.match(output, "TS990001", "Diagnostic carries the stable native mixin-diagnostic code")
    } finally {
        await fixture.dispose()
    }
})
