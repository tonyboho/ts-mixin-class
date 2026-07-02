import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// VARIANCE ANNOTATIONS (`in` / `out`, TS 4.7) on a generic mixin's type parameters. Legal on
// the class (and on the generated interface), but ILLEGAL on function/method type parameters
// (TS1274) — so the transform must not clone them verbatim into generated SIGNATURE positions
// (the factory function, the `.mix` static).

async function build(text: string, compilerOptions?: Record<string, unknown>): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : [ { fileName: "source.ts", text } ]
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

const varianceAnnotatedMixins = trimIndent(`
    import { mixin } from "ts-mixin-class"

    // NB: the annotated parameters must be HONESTLY variant (methods only — any mutable
    // public field would make T invariant and TS2636 the annotation in plain TS already).
    @mixin()
    class Producer<out T> {
        produce(): readonly T[] {
            return []
        }
    }

    @mixin()
    class Sink<in T> {
        accept(value: T): string {
            return typeof value
        }
    }

    class Pipe<T> implements Producer<T>, Sink<T> {
    }

    const pipe = new Pipe<number>()

    const out: readonly number[] = pipe.produce()
    const kind: string           = pipe.accept(2)

    void [ out, kind ]
`)

it("variance-annotated mixin type parameters compile in emit", async (t: Test) => {
    const result = await build(varianceAnnotatedMixins)

    t.equal(result.exitCode, 0,
        `in/out on a mixin's type parameters must not leak into signature positions (TS1274).\n${commandOutput(result)}`)
})

it("variance-annotated mixin type parameters stay clean in source-view", async (t: Test) => {
    const result = await build(varianceAnnotatedMixins, { noEmit: true })

    t.equal(result.exitCode, 0,
        `the source-view plane accepts the annotations too.\n${commandOutput(result)}`)
})
