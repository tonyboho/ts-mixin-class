import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// MEMBER decorators (standard TC39 decorators, `experimentalDecorators: false`). A user
// decorator on a CONSUMER CLASS is supported (§2.8) and on a `@mixin` CLASS is a deferred gap
// (TODO.md) — but decorators on MEMBERS are a separate surface: a consumer's members are
// preserved through the heritage rewrite, and a mixin's members ride inside the factory class
// expression (so a mixin member decorator would run per APPLICATION, like a static block —
// §1.18).

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

const decoratorHelpers = trimIndent(`
    const seen: string[] = []

    function logged<T extends (...args: never[]) => unknown>(method: T, context: ClassMethodDecoratorContext): T {
        seen.push(String(context.name))
        return method
    }

    function tracked<This, Value>(value: undefined, context: ClassFieldDecoratorContext<This, Value>): (initial: Value) => Value {
        seen.push(String(context.name))
        return (initial: Value) => initial
    }
`)

it("member decorators on a CONSUMER's own members survive the heritage rewrite", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        ${decoratorHelpers}

        @mixin()
        class Greeter {
            greet(): string {
                return "hi"
            }
        }

        class Worker implements Greeter {
            @tracked
            load: number = 0

            @logged
            work(): string {
                return this.greet() + "/worked"
            }
        }

        const worker = new Worker()

        const worked: string = worker.work()

        void [ worked, seen ]
    `)

    const emit = await build(source)

    t.equal(emit.exitCode, 0, `emit: decorated consumer members compile.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("member decorators on a MIXIN's members compile (per-application semantics, like §1.18)", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        ${decoratorHelpers}

        @mixin()
        class Audited {
            @tracked
            count: number = 0

            @logged
            act(): string {
                return "acted"
            }
        }

        class Actor implements Audited {
        }

        const actor = new Actor()

        const acted: string = actor.act()

        void [ acted, seen ]
    `)

    const emit = await build(source)

    t.equal(emit.exitCode, 0, `emit: decorated mixin members ride inside the factory.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})
