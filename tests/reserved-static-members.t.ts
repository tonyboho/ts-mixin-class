import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// RESERVED framework statics — on a `@mixin` ONLY. `static mix` collides with the framework's
// mixin application method (`.mix(base)` installed on every mixin value), `static new` with the
// construction protocol — both rejected with a clean native diagnostic on the mixin. Plain
// classes and CONSUMERS are unrestricted: a consumer's own `static new` OVERRIDES the generated
// factory (the transform skips generating its own — `hasStaticNew`), and a consumer's
// `static mix` is an ordinary user static (the framework `.mix` lives on mixin values only and
// is excluded from the consumer's inherited statics bag).

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

const staticMixOnMixin = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Sortable {
        order: number = 0

        static mix(): string {
            return "collides"
        }
    }

    void Sortable
`)

it("a user 'static mix' on a @mixin is rejected — the name is the framework's application method", async (t: Test) => {
    const emit       = await build(staticMixOnMixin)
    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: rejected")
    t.match(emitOutput, "TS9900", `a native diagnostic, not a raw collision.\n${emitOutput}`)
    t.match(emitOutput, "static member 'mix' is reserved", "the message names the reserved static")

    const sourceView       = await build(staticMixOnMixin, { noEmit: true })
    const sourceViewOutput = commandOutput(sourceView)

    t.ne(sourceView.exitCode, 0, "source view: rejected identically")
    t.match(sourceViewOutput, "static member 'mix' is reserved", `both planes agree.\n${sourceViewOutput}`)
})

it("a user 'static mix' on a CONSUMER stays legal — consumers carry no framework .mix", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Greeter {
            greet(): string {
                return "hi"
            }
        }

        class Blender implements Greeter {
            static mix(parts: string[]): string {
                return parts.join("+")
            }
        }

        const blended: string = Blender.mix([ "a", "b" ])
        const greeted: string = new Blender().greet()

        void [ blended, greeted ]
    `))

    t.equal(result.exitCode, 0, `a consumer's own static mix compiles.\n${commandOutput(result)}`)
})

it("a user's own 'static new' on a construction CLASS overrides the generated factory", async (t: Test) => {
    const result = await build(trimIndent(`
        import { Base } from "ts-mixin-class"

        class Document extends Base {
            public title: string = ""

            static new(title: string): Document {
                return super.new({ title }) as Document
            }
        }

        const doc = Document.new("spec")
        const titled: string = doc.title

        function typeOnlyChecks(): void {
            // @ts-expect-error the USER signature governs: the generated config object form is gone
            Document.new({ title: "spec" })
        }

        void typeOnlyChecks
        void titled
    `))

    t.equal(result.exitCode, 0,
        `the user's positional factory wins; no generated duplicate.\n${commandOutput(result)}`)
})

it("a user 'static new' on a @mixin is rejected — mixins keep the framework construction protocol", async (t: Test) => {
    // On a MIXIN the static surface is the framework's: fully supporting a user `static new`
    // would need the factory's `base` parameter to carry the required base's statics
    // (`super.new` inside a mixin static resolves against bare `AnyConstructor<Base>` in emit —
    // a plane divergence). Mixin users are expected to stay off the system methods; the
    // override capability lives on plain classes and consumers instead.
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        class Titled extends Base {
            public title: string = ""

            static new(title: string): Titled {
                return { title } as Titled
            }
        }

        void Titled
    `)

    const emit       = await build(source)
    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: rejected")
    t.match(emitOutput, "static member 'new' is reserved", `the message names the reserved static.\n${emitOutput}`)

    const sourceView       = await build(source, { noEmit: true })
    const sourceViewOutput = commandOutput(sourceView)

    t.ne(sourceView.exitCode, 0, "source view: rejected identically")
    t.match(sourceViewOutput, "static member 'new' is reserved", `both planes agree.\n${sourceViewOutput}`)
})
