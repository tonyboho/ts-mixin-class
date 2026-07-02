import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// Strict-option edges over the GENERATED surfaces. `verbatimModuleSyntax` is pinned corpus-wide
// (fixture-suite tsconfig) — it guards the injected helper import's type/value split on every
// fixture. `exactOptionalPropertyTypes` gets its pin here: the generated `<Class>Config` is all
// OPTIONAL keys (`name?: T`), and under the option an optional key may be ABSENT but may not be
// explicitly `undefined`. `noImplicitOverride` is a SPEC decision pinned here: a mixin member
// IS inherited after the transform, so the option extends to mixin-member overrides — the user
// marks them `override` exactly as with a real `extends` (the modifier is legal in the default
// config too, on a consumer AND on a mixin over its dependency).

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

const constructionSource = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    class Named extends Base {
        public name: string = "unnamed"
    }

    class Widget extends Base implements Named {
        public size!: number
    }

    const widget = Widget.new({ size: 3, name: "w" })
    const bare   = Widget.new({ size: 1 })

    // The config keys are OPTIONAL, and under exactOptionalPropertyTypes optional means
    // "may be absent" — an EXPLICIT undefined is rejected (TS2379/TS2375 family).
    // @ts-expect-error exactOptionalPropertyTypes rejects an explicit undefined config value
    const broken = Widget.new({ size: 2, name: undefined })

    const sized: number = widget.size

    void [ bare, broken, sized ]
`)

it("construction .new config under exactOptionalPropertyTypes (emit)", async (t: Test) => {
    const result = await build(constructionSource, { exactOptionalPropertyTypes: true })

    t.equal(result.exitCode, 0,
        `optional config keys stay usable; explicit undefined is rejected.\n${commandOutput(result)}`)
})

it("construction .new config under exactOptionalPropertyTypes (source view)", async (t: Test) => {
    const result = await build(constructionSource, { exactOptionalPropertyTypes: true, noEmit: true })

    t.equal(result.exitCode, 0, `the source-view plane agrees.\n${commandOutput(result)}`)
})

// ---------------------------------------------------------------------------
// noImplicitOverride

const unmarkedOverrides = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Greeter {
        greet(): string {
            return "hi"
        }
    }

    class Worker implements Greeter {
        greet(): string {
            return "hello"
        }
    }

    @mixin()
    class Loud implements Greeter {
        greet(): string {
            return "HI"
        }
    }

    void [ new Worker().greet(), new Loud().greet() ]
`)

// The same graph with the overrides MARKED (the mixin's own greet overrides nothing and
// stays unmarked).
const markedOverrides = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Greeter {
        greet(): string {
            return "hi"
        }
    }

    class Worker implements Greeter {
        override greet(): string {
            return "hello"
        }
    }

    @mixin()
    class Loud implements Greeter {
        override greet(): string {
            return "HI"
        }
    }

    void [ new Worker().greet(), new Loud().greet() ]
`)

it("noImplicitOverride EXTENDS to mixin-member overrides: unmarked → TS4114 (spec decision)", async (t: Test) => {
    // A mixin member IS inherited after the transform, so the option demands the marker even
    // though the source class has no `extends` clause (plain TS would not). Known cosmetic
    // gap: the message names the GENERATED base (`__Worker$base` / `}`), not the mixin — see
    // TODO.md "Generated base names leak into CHECKER diagnostic messages".
    const emit = await build(unmarkedOverrides, { noImplicitOverride: true })

    t.ne(emit.exitCode, 0, "emit: rejected")
    t.match(commandOutput(emit), "TS4114", "…with the override-modifier demand, on the consumer")

    const sourceView = await build(unmarkedOverrides, { noImplicitOverride: true, noEmit: true })

    t.ne(sourceView.exitCode, 0, "source view: rejected the same")
    t.match(commandOutput(sourceView), "TS4114", "…with the same code")
})

it("`override` on a mixin-member override satisfies noImplicitOverride (consumer AND mixin-over-dependency)", async (t: Test) => {
    const emit = await build(markedOverrides, { noImplicitOverride: true })

    t.equal(emit.exitCode, 0, `emit: the marked overrides compile.\n${commandOutput(emit)}`)

    const sourceView = await build(markedOverrides, { noImplicitOverride: true, noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("`override` on a mixin-member override is legal in the DEFAULT config too", async (t: Test) => {
    const emit = await build(markedOverrides)

    t.equal(emit.exitCode, 0,
        `emit: plain TS would reject override without extends (TS4112); the transformed plane accepts it.\n${commandOutput(emit)}`)

    const sourceView = await build(markedOverrides, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})
