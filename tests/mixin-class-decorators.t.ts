import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// USER decorators on a `@mixin` CLASS (the class-level sibling of §2.20's member decorators).
// The decorator applies ONCE, to the mixin VALUE the user holds (the §2.8 consumer parallel) —
// consumers compose through the factory and are not re-decorated. Emit shapes:
//
// - STANDARD mode: the value is built through an IIFE holding a REAL decorated class
//   declaration (`const W = (() => { @dec class W extends (defineMixinClass(…) as unknown as
//   AnyConstructor) {} return W })() as unknown as <cast>`) — the COMPILER emits the whole
//   TC39 machinery (context, Symbol.metadata, addInitializer, replacement rebinding); the
//   inner class is type-erased so the public cast (and generics) stay byte-identical.
// - LEGACY mode: a plain value fold — `__applyLegacyClassDecorators__(defineMixinClass(…),
//   [dec1, dec2])` applying `dec(value) ?? value` bottom-up (no extra class layer).
//
// Source view keeps the decorators on the real class (they were already type-checked there);
// these tests pin the EMIT plane's runtime behavior, previously silently LOST in both modes.

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

it("a STANDARD user decorator on a @mixin runs ONCE on the value the user holds", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const seen: string[] = []

        function register<T extends abstract new (...args: never[]) => unknown>(value: T, context: ClassDecoratorContext<T>): void {
            seen.push(context.kind + ":" + String(context.name))
            void value
        }

        @mixin()
        @register
        class Widget {
            label: string = "w"
        }

        class Panel implements Widget {
        }

        const widget = new Widget()
        const panel  = new Panel()

        console.log(JSON.stringify({
            seen,
            standalone : widget.label,
            consumer   : panel.label,
            branded    : panel instanceof Widget,
            named      : Widget.name
        }))
    `)

    const { emit, run } = await buildAndRun(source, false)

    t.equal(emit.exitCode, 0, `emit compiles.\n${commandOutput(emit)}`)
    t.equal(
        run?.stdout.trim(),
        JSON.stringify({ seen: [ "class:Widget" ], standalone: "w", consumer: "w", branded: true, named: "Widget" }),
        `the decorator ran once, with the real kind/name; the mixin still works.\n${run === undefined ? "" : commandOutput(run)}`
    )

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("MULTIPLE standard decorators apply bottom-up, around the @mixin marker, in source order", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const applied: string[] = []

        function tag(name: string) {
            return (value: unknown, context: ClassDecoratorContext): void => {
                applied.push(name)
                void [ value, context ]
            }
        }

        @tag("above")
        @mixin()
        @tag("below")
        class Widget {
            label: string = "w"
        }

        console.log(JSON.stringify({ applied, works: new Widget().label }))
    `)

    const { emit, run } = await buildAndRun(source, false)

    t.equal(emit.exitCode, 0, `emit compiles.\n${commandOutput(emit)}`)
    // TC39: application order is bottom-up — "below" first, then "above"; @mixin itself is
    // excluded, the user decorators keep their relative order.
    t.equal(
        run?.stdout.trim(),
        JSON.stringify({ applied: [ "below", "above" ], works: "w" }),
        `both user decorators applied bottom-up.\n${run === undefined ? "" : commandOutput(run)}`
    )
})

it("a standard decorator's addInitializer runs against the final class", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const initialized: string[] = []

        function withInit(value: unknown, context: ClassDecoratorContext): void {
            context.addInitializer(function (this: { name: string }) {
                initialized.push(this.name)
            })
            void value
        }

        @mixin()
        @withInit
        class Widget {
            label: string = "w"
        }

        console.log(JSON.stringify({ initialized, works: new Widget().label }))
    `)

    const { emit, run } = await buildAndRun(source, false)

    t.equal(emit.exitCode, 0, `emit compiles.\n${commandOutput(emit)}`)
    t.equal(
        run?.stdout.trim(),
        JSON.stringify({ initialized: [ "Widget" ], works: "w" }),
        `the extra initializer ran with this = the final class.\n${run === undefined ? "" : commandOutput(run)}`
    )
})

it("a standard REPLACEMENT decorator rebinds the value; consumers keep composing", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        function fancy<T extends new (...args: any[]) => object>(value: T, context: ClassDecoratorContext): T {
            void context

            return class extends value {
                extra(): string {
                    return "extra"
                }
            }
        }

        @mixin()
        @fancy
        class Widget {
            label: string = "w"
        }

        class Panel implements Widget {
        }

        const widget = new Widget() as Widget & { extra(): string }
        const panel  = new Panel()

        console.log(JSON.stringify({
            extra    : widget.extra(),
            consumer : panel.label,
            branded  : panel instanceof Widget
        }))
    `)

    const { emit, run } = await buildAndRun(source, false)

    t.equal(emit.exitCode, 0, `emit compiles.\n${commandOutput(emit)}`)
    // The replacement affects the VALUE (standalone construction); consumers compose through
    // the factory — they do not see `extra`, but stay branded and functional.
    t.equal(
        run?.stdout.trim(),
        JSON.stringify({ extra: "extra", consumer: "w", branded: true }),
        `the replacement class is what the user holds.\n${run === undefined ? "" : commandOutput(run)}`
    )
})

it("LEGACY user decorators on a @mixin: once, bottom-up, replacement supported", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const applied: string[] = []

        function tag(name: string) {
            return (target: new (...args: any[]) => object): void => {
                applied.push(name + ":" + target.name)
            }
        }

        function fancy<T extends new (...args: any[]) => object>(target: T): T {
            return class extends target {
                extra(): string {
                    return "extra"
                }
            }
        }

        @tag("above")
        @mixin()
        @fancy
        @tag("below")
        class Widget {
            label: string = "w"
        }

        class Panel implements Widget {
        }

        const widget = new Widget() as Widget & { extra(): string }

        console.log(JSON.stringify({
            applied,
            extra    : widget.extra(),
            consumer : new Panel().label
        }))
    `)

    const { emit, run } = await buildAndRun(source, true)

    t.equal(emit.exitCode, 0, `emit compiles.\n${commandOutput(emit)}`)
    // Bottom-up: tag("below") sees the canonical "Widget"; fancy replaces it; tag("above")
    // sees the (anonymous, extends-Widget) replacement.
    t.equal(
        run?.stdout.trim(),
        JSON.stringify({ applied: [ "below:Widget", "above:" ], extra: "extra", consumer: "w" }),
        `legacy decorators fold bottom-up over the value.\n${run === undefined ? "" : commandOutput(run)}`
    )

    const sourceView = await build(source, { noEmit: true }, true)

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("a decorated mixin in a NESTED scope (function body + plain block) decorates per enclosing run", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const seen: string[] = []

        function register(value: unknown, context: ClassDecoratorContext): void {
            seen.push(String(context.name))
            void value
        }

        function scope(): string {
            @mixin()
            @register
            class Local {
                label: string = "local"
            }

            class User implements Local {
            }

            return new User().label
        }

        let blockLabel = ""

        // A PLAIN block (not a function body): the generated siblings splice into the block.
        {
            @mixin()
            @register
            class Blocky {
                label: string = "blocky"
            }

            class BlockUser implements Blocky {
            }

            blockLabel = new BlockUser().label
        }

        console.log(JSON.stringify({ first: scope(), second: scope(), blockLabel, seen }))
    `)

    const { emit, run } = await buildAndRun(source, false)

    t.equal(emit.exitCode, 0, `emit compiles.\n${commandOutput(emit)}`)
    // The block runs once (its statements execute before the console.log call evaluates
    // `scope()` twice), so the application order is Blocky, Local, Local.
    t.equal(
        run?.stdout.trim(),
        JSON.stringify({ first: "local", second: "local", blockLabel: "blocky", seen: [ "Blocky", "Local", "Local" ] }),
        `the nested mixins' decorators run once per enclosing run (the documented per-call cost).\n${run === undefined ? "" : commandOutput(run)}`
    )

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("a decorated mixin in a NESTED scope, LEGACY mode", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const seen: string[] = []

        function register(target: new (...args: any[]) => object): void {
            seen.push(target.name)
        }

        function scope(): string {
            @mixin()
            @register
            class Local {
                label: string = "local"
            }

            class User implements Local {
            }

            return new User().label
        }

        console.log(JSON.stringify({ first: scope(), second: scope(), seen }))
    `)

    const { emit, run } = await buildAndRun(source, true)

    t.equal(emit.exitCode, 0, `emit compiles.\n${commandOutput(emit)}`)
    t.equal(
        run?.stdout.trim(),
        JSON.stringify({ first: "local", second: "local", seen: [ "Local", "Local" ] }),
        `the legacy fold runs per enclosing call, on the named value.\n${run === undefined ? "" : commandOutput(run)}`
    )

    const sourceView = await build(source, { noEmit: true }, true)

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})
