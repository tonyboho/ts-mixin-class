import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// SPEC (currently UNMET — this test is expected to be RED until fixed): a `@mixin` class
// is allowed to have a **defaulted** type parameter, exactly like any other generic class.
//
// Today this fails to compile with TS2706 ("Required type parameters may not follow
// optional type parameters"). The generated value-cast emits
//   readonly mix: <V = number, __MixinBase extends AnyConstructor<any>>(base: __MixinBase) => …
// where the synthetic, *required* `__MixinBase` follows the mixin's own *optional*
// (defaulted) `V`. The error surfaces for any defaulted-param mixin whether or not `.mix`
// is ever called (the signature is always generated). Likely fix: default `__MixinBase`
// (`= AnyConstructor<any>`) so it is optional too, or emit it before the own params —
// and audit the same shape on the generated `<ClassName>Config<T>` alias. Tracked as the
// §6.5 gap in USE-CASES.md. The companion working shapes (multi-param, constrained) are in
// the green fixture `fixture-suite/src/generic-mixin-variations.t.ts`.
const defaultedTypeParamMixinText = `
import { mixin } from "ts-mixin-class"

@mixin()
class Boxed<V = number> {
    value!: V

    get(): V {
        return this.value
    }
}

class StringBox implements Boxed<string> {
}

class DefaultBox implements Boxed {
}

const s = new StringBox()
const d = new DefaultBox()

s.value = "x"
d.value = 1

void [ s.get(), d.get() ]
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

it("a mixin may declare a defaulted type parameter (compiles in emit and source-view)", async (t: Test) => {
    const emitResult       = await buildFixture(defaultedTypeParamMixinText, undefined)
    const sourceViewResult = await buildFixture(defaultedTypeParamMixinText, { noEmit: true })

    t.equal(emitResult.exitCode, 0,
        `Emit build of a defaulted-type-parameter mixin should succeed.\n${commandOutput(emitResult)}`)

    t.equal(sourceViewResult.exitCode, 0,
        `Source-view (noEmit) build of a defaulted-type-parameter mixin should succeed.\n${commandOutput(sourceViewResult)}`)
})
