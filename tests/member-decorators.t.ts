import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// MEMBER decorators, BOTH modes (standard TC39 and legacy `experimentalDecorators`). A user
// decorator on a CONSUMER CLASS is supported (§2.8) and on a `@mixin` CLASS is a deferred gap
// (TODO.md) — but decorators on MEMBERS are a separate surface: a consumer's members are
// preserved through the heritage rewrite, and a mixin's members ride inside the factory body
// (so a mixin member decorator runs per APPLICATION, like a static block — §1.18). The factory
// emits a named class DECLARATION (`class __X$class extends base { … } return __X$class`),
// not a class expression, precisely so LEGACY member decorators stay valid (legacy decorators
// are TS1206 on class-expression members).

async function build(
    text: string,
    compilerOptions?: Record<string, unknown>,
    experimentalDecorators: boolean = false
): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators,
        compilerOptions,
        sourceFiles : [ { fileName: "source.ts", text } ]
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

// Build the emit plane AND execute the emitted JS — for the runtime-count pins of the
// mode-specific shapes that cannot ride the dual-built fixture corpus.
async function buildAndRun(
    text: string,
    experimentalDecorators: boolean
): Promise<{ emit: CommandResult, run: CommandResult | undefined }> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators,
        sourceFiles : [ { fileName: "source.ts", text } ]
    })

    try {
        const emit = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const run  = emit.exitCode === 0
            ? await runCommand("node", [ path.join("dist", "source.js") ], fixture.directory)
            : undefined

        return { emit, run }
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

// Legacy decorators have a different calling convention — (target, key, descriptor?) — so the
// legacy tests carry their own helper shapes.
const legacyDecoratorHelpers = trimIndent(`
    const seen: string[] = []

    function logged(target: object, key: string, descriptor: PropertyDescriptor): void {
        seen.push(key)
        void [ target, descriptor ]
    }

    function tracked(target: object, key: string): void {
        seen.push(key)
    }
`)

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

it("LEGACY member decorators on a CONSUMER's own members survive the heritage rewrite", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        ${legacyDecoratorHelpers}

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

    const emit = await build(source, undefined, true)

    t.equal(emit.exitCode, 0, `emit: legacy-decorated consumer members compile.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true }, true)

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("LEGACY member decorators on a MIXIN's members compile (the factory class is a DECLARATION)", async (t: Test) => {
    // The load-bearing case: with the factory returning a class EXPRESSION this was TS1206
    // ("Decorators are not valid here") — legacy decorators are invalid on class-expression
    // members. The factory's named class DECLARATION makes them legal.
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        ${legacyDecoratorHelpers}

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

    const emit = await build(source, undefined, true)

    t.equal(emit.exitCode, 0, `emit: legacy-decorated mixin members compile through the factory.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true }, true)

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

// ---------------------------------------------------------------------------
// Mode-SPECIFIC decorator shapes (cannot ride the dual-built fixture corpus): the standard
// get+set pair (legacy allows only ONE half — TS1207), the standard AUTO-ACCESSOR decorator,
// and LEGACY-only parameter decorators. Each pins compile (both planes) and the per-application
// runtime counts through the emitted JS.

it("STANDARD accessor decorators on BOTH halves of a mixin's get/set pair", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const decorated: string[] = []

        function audit(value: unknown, context: ClassGetterDecoratorContext | ClassSetterDecoratorContext): void {
            decorated.push(context.kind + ":" + String(context.name))
            void value
        }

        @mixin()
        class Measured {
            stored: number = 1

            @audit
            get value(): number {
                return this.stored
            }

            @audit
            set value(input: number) {
                this.stored = input
            }
        }

        class Meter implements Measured {
        }

        const meter = new Meter()

        meter.value = 42

        console.log("decorated=" + decorated.join(",") + " value=" + meter.value)
    `)

    const { emit, run } = await buildAndRun(source, false)

    t.equal(emit.exitCode, 0, `emit: decorated get AND set halves compile.\n${commandOutput(emit)}`)
    // 2 applications (canonical + Meter's empty base) × (getter + setter).
    t.equal(
        run?.stdout.trim(),
        "decorated=getter:value,setter:value,getter:value,setter:value value=42",
        `both halves' decorators run per application; the accessor still works.\n${run === undefined ? "" : commandOutput(run)}`
    )

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("a STANDARD decorator on a mixin's AUTO-ACCESSOR (`@dec accessor x`)", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const decorated: string[] = []

        function audit<This, Value>(
            value: ClassAccessorDecoratorTarget<This, Value>,
            context: ClassAccessorDecoratorContext<This, Value>
        ): void {
            decorated.push(context.kind + ":" + String(context.name))
            void value
        }

        @mixin()
        class Tagged {
            @audit
            accessor tag: string = "initial"
        }

        class Item implements Tagged {
        }

        const item = new Item()

        item.tag = "set"

        console.log("decorated=" + decorated.join(",") + " tag=" + item.tag)
    `)

    const { emit, run } = await buildAndRun(source, false)

    t.equal(emit.exitCode, 0, `emit: the decorated auto-accessor compiles.\n${commandOutput(emit)}`)
    t.equal(
        run?.stdout.trim(),
        "decorated=accessor:tag,accessor:tag tag=set",
        `the accessor decorator runs per application; the backing slot still works.\n${run === undefined ? "" : commandOutput(run)}`
    )

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("LEGACY parameter decorators on a mixin method", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const params: string[] = []

        function audit(target: object, key: string | undefined, index: number): void {
            params.push(String(key) + ":" + index)
            void target
        }

        @mixin()
        class Handled {
            handle(@audit input: string): string {
                return "handled:" + input
            }
        }

        class Handler implements Handled {
        }

        console.log("params=" + params.join(",") + " out=" + new Handler().handle("x"))
    `)

    const { emit, run } = await buildAndRun(source, true)

    t.equal(emit.exitCode, 0, `emit: the parameter decorator compiles inside the factory.\n${commandOutput(emit)}`)
    // 2 applications (canonical + Handler's empty base) × 1 decorated parameter.
    t.equal(
        run?.stdout.trim(),
        "params=handle:0,handle:0 out=handled:x",
        `the parameter decorator runs per application; the method still works.\n${run === undefined ? "" : commandOutput(run)}`
    )

    const sourceView = await build(source, { noEmit: true }, true)

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})
