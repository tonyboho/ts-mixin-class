import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// RESERVED framework statics. `static mix` on a `@mixin` collides with the framework's mixin
// application method (`.mix(base)` installed on every mixin value) — rejected with a clean
// native diagnostic. `static new` is NOT reserved ANYWHERE: a user's own factory OVERRIDES the
// generated construction `.new` (the transform skips generating its own — `hasStaticNew`, and
// on a mixin the direct-`new` brand is lifted with it), on a construction mixin exactly like
// on a plain construction class or a consumer; on a non-construction mixin it is an ordinary
// user static. A consumer's `static mix` is also an ordinary user static (the framework `.mix`
// lives on mixin values only and is excluded from the consumer's inherited statics bag).

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

it("a user's own 'static new' on a construction MIXIN overrides the generated factory in both planes", async (t: Test) => {
    // Owning `static new` also lifts the direct-`new` brand (the user owns construction now) —
    // so the factory body can build via `new Titled()`. Delegating via `super.new(...)` works
    // too (the factory's `base` parameter carries the base statics) — pinned separately in
    // mixin-static-super.t.ts; this test keeps the direct-`new` body as its own case.
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        class Titled extends Base {
            public title: string = ""

            static new(title: string): Titled {
                const instance = new Titled()

                instance.title = title

                return instance
            }
        }

        const titled = Titled.new("spec")
        const read: string = titled.title

        function typeOnlyChecks(): void {
            // @ts-expect-error the USER signature governs: the generated config object form is gone
            Titled.new({ title: "spec" })
        }

        void typeOnlyChecks
        void read
    `)

    const emit = await build(source)

    t.equal(emit.exitCode, 0, `emit: the user's factory wins on the mixin value.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("a user 'static new' on a NON-construction mixin is an ordinary factory", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Maker {
            tag: string = ""

            static new(tag: string): Maker {
                const made = new Maker()

                made.tag = tag

                return made
            }
        }

        const made = Maker.new("m")
        const tag: string = made.tag

        void tag
    `)

    const emit = await build(source)

    t.equal(emit.exitCode, 0, `emit: no construction machinery, nothing reserved.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

// The complement of the override behaviour above (§7.21): the GENERATED `.new` is
// reachable from a static helper inside the class's own body — construction class AND
// construction mixin.
it("a static helper calling the GENERATED .new from inside the class body", async (t: Test) => {
    const result = await build(trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        export class Job extends Base {
            public name: string = ""

            static make(name: string): Job {
                return Job.new({ name })
            }
        }

        @mixin()
        export class Task extends Base {
            public title: string = ""

            static make(title: string): Task {
                return Task.new({ title })
            }
        }

        const job  = Job.make("build")
        const task = Task.make("deploy")

        const jobName: string   = job.name
        const taskTitle: string = task.title

        void [ jobName, taskTitle ]
    `))

    t.equal(result.exitCode, 0,
        `the generated .new is reachable from the class's own statics (class AND mixin).\n${commandOutput(result)}`)
})
