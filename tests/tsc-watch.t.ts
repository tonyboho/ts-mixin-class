import { writeFile } from "node:fs/promises"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile } from "./util.js"
import { errorCount, startTscWatch } from "./tsc-watch-util.js"

// End-to-end watch-mode test: drive a REAL `tsc --watch` process over a fixture (not an
// in-process program like `stress-edit`) and assert diagnostics stay correct across rebuilds.
//
// What it pins: under watch, TypeScript rebuilds the program incrementally on each file change.
// The program transform must be re-invoked on every rebuild AND its per-program caches (facts,
// registry, import maps) must invalidate for the changed file — otherwise a cross-file mixin
// edit would serve a STALE injected interface and the consumer would keep type-checking against
// members that no longer exist. The round-trip (break -> rebuild -> revert -> rebuild) proves
// both the staleness (the break must surface) and the recovery (the revert must clear).
//
// The watch process (the package's own patched `tsc`, launched with `-w`) is driven through
// `tsc-watch-util`; this file owns only the cross-file-mixin scenario.

// A `@mixin` exposing one method; the method name is parameterized so we can rename it under
// watch to break (and then restore) the consumer that calls it.
const greeterMixin = (methodName: string): string => `
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class Greeter {
        ${methodName}(): string {
            return "hello"
        }
    }
`

const greeterConsumer = `
    import { Greeter } from "./mixin.js"

    class Consumer implements Greeter {
    }

    const consumer = new Consumer()

    void consumer.greet()
`

it("reports and clears a cross-file mixin error across tsc --watch rebuilds", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { noEmit: true },
        sourceFiles            : [
            { fileName: "mixin.ts", text: greeterMixin("greet") },
            { fileName: "consumer.ts", text: greeterConsumer }
        ]
    })

    const mixinFile = requiredFixtureSourceFile(fixture.sourceFiles, "mixin.ts")
    const watch     = startTscWatch(fixture.directory, fixture.tsconfigFile)

    try {
        const initial = await watch.waitForBuild()

        t.is(errorCount(initial), 0, "Initial watch build is clean — the transform injected the mixin's `greet` into the consumer")

        // Break it: rename the mixin method. The consumer's `consumer.greet()` only type-checks
        // because the transform injects `greet` into the consumer's interface; after the rename a
        // re-invoked, cache-invalidated transform must drop `greet`, so the call must now error.
        await writeFile(mixinFile, greeterMixin("greetRenamed"))

        const afterBreak = await watch.waitForBuild()

        t.is(errorCount(afterBreak), 1, "Renaming the mixin method surfaces exactly one error on the next rebuild")
        t.match(afterBreak, "consumer.ts", "The error lands in the consumer that calls the renamed member")
        t.match(afterBreak, "greet", "The diagnostic names the now-missing `greet` member")

        // Recover: restore the method. A re-invoked transform must re-inject `greet`, clearing the
        // error — proving the rebuild re-applied the transform rather than serving a stale program.
        await writeFile(mixinFile, greeterMixin("greet"))

        const afterRevert = await watch.waitForBuild()

        t.is(errorCount(afterRevert), 0, "Reverting the mixin restores a clean watch build")
    } finally {
        watch.dispose()
        await fixture.dispose()
    }
})
