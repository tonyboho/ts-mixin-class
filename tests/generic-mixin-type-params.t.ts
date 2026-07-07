import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// Type-parameter EDGES of a generic `@mixin` class, each compiled on both planes (emit and
// source-view): a DEFAULTED own parameter (§6.5), a parameter FORWARDED into a generic
// required base (§4.4/§4.6), and VARIANCE ANNOTATIONS (§1.31).

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

// A `@mixin` class is allowed to have a **defaulted** type parameter, exactly like any other
// generic class.
//
// This used to fail to compile with TS2706 ("Required type parameters may not follow
// optional type parameters"). The generated value-cast emitted
//   readonly mix: <V = number, __MixinBase extends AnyConstructor<any>>(base: __MixinBase) => …
// where the synthetic, *required* `__MixinBase` followed the mixin's own *optional*
// (defaulted) `V`. The error surfaced for any defaulted-param mixin whether or not `.mix`
// was ever called (the signature is always generated). Fixed by defaulting `__MixinBase`
// to its constraint so it is optional too. The companion working shapes (multi-param,
// constrained) are in the green fixture `fixture-suite/src/generic-mixin-variations.t.ts`.
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

it("a mixin may declare a defaulted type parameter (compiles in emit and source-view)", async (t: Test) => {
    const emitResult       = await build(defaultedTypeParamMixinText)
    const sourceViewResult = await build(defaultedTypeParamMixinText, { noEmit: true })

    t.equal(emitResult.exitCode, 0,
        `Emit build of a defaulted-type-parameter mixin should succeed.\n${commandOutput(emitResult)}`)

    t.equal(sourceViewResult.exitCode, 0,
        `Source-view (noEmit) build of a defaulted-type-parameter mixin should succeed.\n${commandOutput(sourceViewResult)}`)
})

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

it("a generic mixin extending a generic required base forwards its type parameter", async (t: Test) => {
    const emitResult       = await build(genericRequiredBaseText)
    const sourceViewResult = await build(genericRequiredBaseText, { noEmit: true })

    t.equal(emitResult.exitCode, 0,
        `Emit build of a forwarded generic required base succeeds.\n${commandOutput(emitResult)}`)

    t.equal(sourceViewResult.exitCode, 0,
        `Source-view (noEmit) build of a forwarded generic required base succeeds.\n${commandOutput(sourceViewResult)}`)
})

// VARIANCE ANNOTATIONS (`in` / `out`, TS 4.7) on a generic mixin's type parameters. Legal on
// the class (and on the generated interface), but ILLEGAL on function/method type parameters
// (TS1274) — so the transform must not clone them verbatim into generated SIGNATURE positions
// (the factory function, the `.mix` static).
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
