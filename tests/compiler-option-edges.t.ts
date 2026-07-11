import { readFile, writeFile } from "node:fs/promises"
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

    t.equal(
        result.exitCode,
        0,
        `optional config keys stay usable; explicit undefined is rejected.\n${commandOutput(result)}`
    )
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
    // though the source class has no `extends` clause (plain TS would not). The message names
    // the MIXIN whose member is overridden ('Greeter'), on both planes and for both the
    // consumer (Worker) and the mixin-over-dependency (Loud) — not the generated base
    // (`__Worker$base` on emit / the collapsed-render `'}'` in source view).
    const emit       = await build(unmarkedOverrides, { noImplicitOverride: true })
    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: rejected")
    t.match(emitOutput, "TS4114", "…with the override-modifier demand, on the consumer")
    t.match(emitOutput, "base class 'Greeter'", `…naming the overridden mixin.\n${emitOutput}`)
    t.notMatch(emitOutput, "$base", "no generated base name leaks")

    const sourceView       = await build(unmarkedOverrides, { noImplicitOverride: true, noEmit: true })
    const sourceViewOutput = commandOutput(sourceView)

    t.ne(sourceView.exitCode, 0, "source view: rejected the same")
    t.match(sourceViewOutput, "TS4114", "…with the same code")
    t.match(sourceViewOutput, "base class 'Greeter'", `…naming the same mixin.\n${sourceViewOutput}`)
    t.notMatch(sourceViewOutput, "base class '}'", "no collapsed-position render leaks")
})

it("`override` on a mixin-member override satisfies noImplicitOverride (consumer AND mixin-over-dependency)", async (t: Test) => {
    const emit = await build(markedOverrides, { noImplicitOverride: true })

    t.equal(emit.exitCode, 0, `emit: the marked overrides compile.\n${commandOutput(emit)}`)

    const sourceView = await build(markedOverrides, { noImplicitOverride: true, noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

it("`override` on a mixin-member override is legal in the DEFAULT config too", async (t: Test) => {
    const emit = await build(markedOverrides)

    t.equal(
        emit.exitCode,
        0,
        `emit: plain TS would reject override without extends (TS4112); the transformed plane accepts it.\n${commandOutput(emit)}`
    )

    const sourceView = await build(markedOverrides, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

// ---------------------------------------------------------------------------
// module: CommonJS

it("a CommonJS project compiles and RUNS (require() of the ESM package)", async (t: Test) => {
    // The package itself is ESM (`type: module`, `exports` without a `require` branch), but a
    // CJS project still works end to end: the transform is module-format-agnostic on the emit
    // plane, and modern Node (≥ 20.19) supports require() of an ESM module — which is what the
    // suite's Node runs. `ignoreDeprecations` only silences TS 6.0's own CommonJS-era warnings.
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { module: "CommonJS", ignoreDeprecations: "6.0" },
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : trimIndent(`
                import { mixin } from "ts-mixin-class"

                @mixin()
                class Greeter {
                    greet(): string {
                        return "hi"
                    }
                }

                class Worker implements Greeter {
                }

                console.log("out=" + new Worker().greet())
            `)
        } ]
    })

    try {
        const emit = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.equal(emit.exitCode, 0, `the CommonJS emit compiles.\n${commandOutput(emit)}`)

        // A real CommonJS project is not `type: module` — replace the harness default so the
        // emitted CJS is executed as CJS.
        await writeFile(
            path.join(fixture.directory, "package.json"),
            JSON.stringify({ private: true, type: "commonjs" })
        )

        const run = await runCommand("node", [ path.join("dist", "source.js") ], fixture.directory)

        t.equal(run.exitCode, 0, `the CJS output runs.\n${commandOutput(run)}`)
        t.equal(run.stdout.trim(), "out=hi", "the mixin chain works from CommonJS")
    } finally {
        await fixture.dispose()
    }
})

it("legacy emitDecoratorMetadata is emitted from transformed mixin members and parameters", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { emitDecoratorMetadata: true },
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : trimIndent(`
                import { mixin } from "ts-mixin-class"

                function member(target: object, key: string | symbol): void {
                    void [ target, key ]
                }

                function parameter(target: object, key: string | symbol | undefined, index: number): void {
                    void [ target, key, index ]
                }

                @mixin()
                class Reflected {
                    @member
                    created!: Date

                    @member
                    format(@parameter count: number): string {
                        return String(count)
                    }
                }

                class Consumer implements Reflected {
                }

                void new Consumer().format(1)
            `)
        } ]
    })

    try {
        const emit = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.equal(emit.exitCode, 0, `legacy metadata fixture compiles.\n${commandOutput(emit)}`)

        const js = emit.exitCode === 0
            ? await readFile(path.join(fixture.directory, "dist", "source.js"), "utf8")
            : ""

        t.match(js, '"design:type", Date', "the decorated data field retains design:type")
        t.match(js, '"design:paramtypes", [Number]', "the decorated method retains parameter metadata")
        t.match(js, '"design:returntype", String', "the decorated method retains return metadata")
    } finally {
        await fixture.dispose()
    }
})
