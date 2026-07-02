import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// MEMBER-KIND collisions across the chain. Plain TS rejects a class FIELD shadowing a base
// class ACCESSOR (TS2610: "... is defined as an accessor in class ..., but is overridden here
// as an instance property") — the field's own-property define would bypass the setter. The
// mixin chain must keep that guard: the consumer's base is the generated chain class, typed
// through the generated interface.

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

const fieldOverAccessor = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Measured {
        stored: number = 0

        get value(): number {
            return this.stored
        }

        set value(input: number) {
            this.stored = input
        }
    }

    class Shadowing implements Measured {
        value: number = 5
    }

    void Shadowing
`)

const accessorOverField = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Fielded {
        value: number = 1
    }

    class Wrapping implements Fielded {
        stored: number = 0

        get value(): number {
            return this.stored
        }

        set value(input: number) {
            this.stored = input
        }
    }

    void Wrapping
`)

const mixinOverMixin = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Measured {
        stored: number = 0

        get value(): number {
            return this.stored
        }

        set value(input: number) {
            this.stored = input
        }
    }

    @mixin()
    class Flat {
        value: number = 5
    }

    // Flat is FIRST-listed (the nearest layer), so its FIELD would bury Measured's accessor.
    class Both implements Flat, Measured {
    }

    void Both
`)

it("a consumer FIELD shadowing a mixin ACCESSOR is rejected (TS990010, both class-field semantics)", async (t: Test) => {
    // The checker's own TS2610 cannot see the accessor through the generated interface (it
    // only fires when the base member is declared in a CLASS) — TS990010 re-creates the guard.
    // A field never usefully overrides an accessor, so this direction is diagnosed under BOTH
    // class-field semantics, like plain TS does.
    for (const useDefineForClassFields of [ true, false ]) {
        const result = await build(fieldOverAccessor, { useDefineForClassFields })
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `useDefineForClassFields=${String(useDefineForClassFields)}: rejected`)
        t.match(output, "TS990010", `the native guard fires.\n${output}`)
        t.match(output, "'value' is defined as an accessor in mixin Measured",
            "the message names the buried accessor and its mixin")
    }
})

it("a consumer ACCESSOR over a mixin FIELD is rejected under define semantics only", async (t: Test) => {
    // Deliberate deviation from plain TS2611: under SET semantics the mixin field emits as a
    // constructor assignment, which FIRES the overriding setter — the classic reactive-property
    // pattern — so it stays legal with useDefineForClassFields: false.
    const rejected = await build(accessorOverField, { useDefineForClassFields: true })
    const output   = commandOutput(rejected)

    t.ne(rejected.exitCode, 0, "define semantics: the mixin field initializer would bury the accessor")
    t.match(output, "TS990010", `the native guard fires.\n${output}`)
    t.match(output, "'value' is defined as a property in mixin Fielded", "the message names the field and its mixin")

    const legal = await build(accessorOverField, { useDefineForClassFields: false })

    t.equal(legal.exitCode, 0,
        `set semantics: the field assignment fires the overriding setter — legal.\n${commandOutput(legal)}`)
})

it("a nearer mixin FIELD over a deeper mixin ACCESSOR is rejected across one implements list", async (t: Test) => {
    const result = await build(mixinOverMixin, { useDefineForClassFields: false })
    const output = commandOutput(result)

    t.ne(result.exitCode, 0, "the mixin-vs-mixin kind mismatch is rejected")
    t.match(output, "TS990010", `the native guard fires.\n${output}`)
    t.match(output, "mixin Flat", "the message names the overriding (nearer) mixin")
    t.match(output, "mixin Measured", "…and the buried (deeper) one")
})

it("a consumer overriding a mixin METHOD with a narrowed return still chains through super", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Describable {
            describe(): string {
                return "base"
            }
        }

        class Narrowed implements Describable {
            override describe(): "wrapped(base)" {
                return ("wrapped(" + super.describe() + ")") as "wrapped(base)"
            }
        }

        const narrowed: "wrapped(base)" = new Narrowed().describe()

        void narrowed
    `), { noImplicitOverride: true })

    t.equal(result.exitCode, 0,
        `an override with a narrowed return type + super chaining compiles (noImplicitOverride).\n${commandOutput(result)}`)
})

it("a consumer overriding a mixin get/set PAIR keeps the accessor contract", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Measured {
            stored: number = 0

            get value(): number {
                return this.stored
            }

            set value(input: number) {
                this.stored = input
            }
        }

        class Doubling implements Measured {
            get value(): number {
                return this.stored * 2
            }

            set value(input: number) {
                this.stored = input
            }
        }

        const doubling = new Doubling()
        doubling.value = 4
        const read: number = doubling.value

        void read
    `))

    t.equal(result.exitCode, 0, `a full accessor-pair override compiles.\n${commandOutput(result)}`)
})
