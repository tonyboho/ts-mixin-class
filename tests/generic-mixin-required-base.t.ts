import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// Repro for a generic `@mixin` class that extends a generic required base and
// forwards its own type parameter (`@mixin() class M<T> extends Base<T>`).
//
// TODO(generic-required-base forwarding): KNOWN GAP. Forwarding a mixin's own
// type parameter into a generic required base does not compile in either path:
//   - emit produces `TS2304: Cannot find name 'T'` (the value cast that models the
//     mixin loses `T` from scope), and
//   - source view produces `TS2562: Base class expressions cannot reference class
//     type parameters` (the generated metadata base is `extends (<cast using T>)`,
//     which TS forbids for a class type parameter in a base-class expression).
// A required base with a *concrete* type argument (`extends Base<string>`) compiles
// cleanly in both paths — only forwarding the mixin's generic parameter fails. The
// assertions below state the *correct* behaviour (both builds succeed) and are
// wrapped in `t.todo` so they run and stay visible (reported as TODO with failing
// assertions) without failing the suite. No fix yet — see AGENTS.md and README
// Limitations. When the gap is fixed, unwrap the `t.todo`.
const genericRequiredBaseText = `
import { mixin } from "ts-mixin-class"

class RequiredBase<T> {
    requiredValue: T

    constructor(requiredValue: T) {
        this.requiredValue = requiredValue
    }

    requiredMethod(): T {
        return this.requiredValue
    }
}

@mixin()
class GenericMixin<T> extends RequiredBase<T> {
    mixinValue!: T

    mixinMethod(): T {
        return this.mixinValue
    }
}

class Consumer<T> extends RequiredBase<T> implements GenericMixin<T> {
    own(): T {
        return this.mixinValue
    }
}

const consumer = new Consumer<number>(7)

void [ consumer.requiredMethod(), consumer.mixinValue, consumer.own(), consumer.mixinMethod() ]
`

async function buildFixture(compilerOptions: Record<string, unknown> | undefined): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : [ { fileName : "source.ts", text : genericRequiredBaseText } ]
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

it("a generic mixin extending a generic required base forwards its type parameter", async (t: Test) => {
    const emitResult     = await buildFixture(undefined)
    const sourceViewResult = await buildFixture({ noEmit : true })

    t.todo("generic required-base forwarding compiles in both transform paths (generic-required-base gap)", (t: Test) => {
        t.equal(emitResult.exitCode, 0,
            `Emit build of a forwarded generic required base succeeds.\n${commandOutput(emitResult)}`)

        t.equal(sourceViewResult.exitCode, 0,
            `Source-view (noEmit) build of a forwarded generic required base succeeds.\n${commandOutput(sourceViewResult)}`)
    })
})
