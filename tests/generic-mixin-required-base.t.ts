import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// A generic `@mixin` class that extends a generic required base and forwards its
// own type parameter (`@mixin() class M<T> extends Base<T>`).
//
// This used to fail to compile in either path: emit produced `TS2304: Cannot find
// name 'T'` (the top-level value-cast intersection has no enclosing generic scope to
// bind `T`) and source view produced `TS2562: Base class expressions cannot reference
// class type parameters` (the generated `$base` is a base-class *expression*). Both
// errors came from the single forwarded `T` inside the `RuntimeMixinClass<Base<T>>`
// marker. That marker only carries `[base]`; the required base is enforced by the
// generated `interface … extends Base`, the `mix` signature, and consumer-diagnostics
// — so the forwarded type parameter is erased to `any` there (see
// createRuntimeMixinClassType / eraseOwnTypeParameterReferences in mixin-expand.ts).
// That the erasure did not loosen the constraint is guarded on the `implements` path by
// the required-base mismatch diagnostics, and on the published-`.mix` path by
// `declaration-fixture-suite/src/package-manual-mix-generic.t.ts` (program-local `.mix`
// itself is banned — TS990012, `manual-mix-ban.t.ts`).
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

async function buildFixture(
    text: string,
    compilerOptions: Record<string, unknown> | undefined
): Promise<CommandResult> {
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

it("a generic mixin extending a generic required base forwards its type parameter", async (t: Test) => {
    const emitResult       = await buildFixture(genericRequiredBaseText, undefined)
    const sourceViewResult = await buildFixture(genericRequiredBaseText, { noEmit: true })

    t.equal(emitResult.exitCode, 0,
        `Emit build of a forwarded generic required base succeeds.\n${commandOutput(emitResult)}`)

    t.equal(sourceViewResult.exitCode, 0,
        `Source-view (noEmit) build of a forwarded generic required base succeeds.\n${commandOutput(sourceViewResult)}`)
})
