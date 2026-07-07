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

const fieldOverAutoAccessor = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Counted {
        accessor count: number = 0
    }

    class Shadowing implements Counted {
        count: number = 5
    }

    void Shadowing
`)

const pairOverAutoAccessor = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Counted {
        accessor count: number = 0
    }

    class Wrapping implements Counted {
        stored: number = 0

        get count(): number {
            return this.stored
        }

        set count(input: number) {
            this.stored = input
        }
    }

    void Wrapping
`)

const autoAccessorOverField = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Fielded {
        value: number = 1
    }

    class Wrapping implements Fielded {
        accessor value: number = 0
    }

    void Wrapping
`)

it("a consumer FIELD shadowing a mixin ACCESSOR is rejected under define semantics only (TS990010)", async (t: Test) => {
    // The checker's own TS2610 cannot see the accessor through the generated interface (it
    // only fires when the base member is declared in a CLASS) — TS990010 re-creates the guard,
    // but ONLY under define semantics, where the field becomes an own property that buries the
    // prototype accessor. Under set semantics the "field" is just an initializing assignment
    // THROUGH the setter (the accessor stays on the prototype) — sound, so legal: a deliberate
    // deviation from plain TS2610, which rejects unconditionally.
    const rejected = await build(fieldOverAccessor, { useDefineForClassFields: true })
    const output   = commandOutput(rejected)

    t.ne(rejected.exitCode, 0, "define semantics: rejected")
    t.match(output, "TS990010", `the native guard fires.\n${output}`)
    t.match(
        output,
        "'value' is defined as an accessor in mixin Measured",
        "the message names the buried accessor and its mixin"
    )

    const legal = await build(fieldOverAccessor, { useDefineForClassFields: false })

    t.equal(
        legal.exitCode,
        0,
        `set semantics: the field initializer assigns through the mixin setter — legal.\n${commandOutput(legal)}`
    )
})

it("a consumer ACCESSOR over a mixin FIELD is rejected under define semantics only", async (t: Test) => {
    // Same gating, other direction: under SET semantics the mixin field emits as a constructor
    // assignment, which FIRES the overriding setter — the classic reactive-property pattern.
    const rejected = await build(accessorOverField, { useDefineForClassFields: true })
    const output   = commandOutput(rejected)

    t.ne(rejected.exitCode, 0, "define semantics: the mixin field initializer would bury the accessor")
    t.match(output, "TS990010", `the native guard fires.\n${output}`)
    t.match(output, "'value' is defined as a property in mixin Fielded", "the message names the field and its mixin")

    const legal = await build(accessorOverField, { useDefineForClassFields: false })

    t.equal(
        legal.exitCode,
        0,
        `set semantics: the field assignment fires the overriding setter — legal.\n${commandOutput(legal)}`
    )
})

it("a nearer mixin FIELD over a deeper mixin ACCESSOR is rejected across one implements list", async (t: Test) => {
    const rejected = await build(mixinOverMixin, { useDefineForClassFields: true })
    const output   = commandOutput(rejected)

    t.ne(rejected.exitCode, 0, "the mixin-vs-mixin kind mismatch is rejected under define semantics")
    t.match(output, "TS990010", `the native guard fires.\n${output}`)
    t.match(output, "mixin Flat", "the message names the overriding (nearer) mixin")
    t.match(output, "mixin Measured", "…and the buried (deeper) one")

    const legal = await build(mixinOverMixin, { useDefineForClassFields: false })

    t.equal(
        legal.exitCode,
        0,
        `set semantics: the nearer field initializes through the deeper setter — legal.\n${commandOutput(legal)}`
    )
})

it("a consumer FIELD shadowing a mixin AUTO-ACCESSOR is rejected under define semantics only", async (t: Test) => {
    // The `accessor` keyword is syntactically a PropertyDeclaration, but at runtime a real
    // get/set pair on the mixin layer's prototype — the kind classification must follow the
    // RUNTIME kind, so this is the field-over-accessor hazard of §2.14, not field-over-field.
    const rejected = await build(fieldOverAutoAccessor, { useDefineForClassFields: true })
    const output   = commandOutput(rejected)

    t.ne(rejected.exitCode, 0, "define semantics: rejected")
    t.match(output, "TS990010", `the native guard fires.\n${output}`)
    t.match(
        output,
        "'count' is defined as an accessor in mixin Counted",
        "the auto-accessor classifies as an accessor in the message"
    )

    const legal = await build(fieldOverAutoAccessor, { useDefineForClassFields: false })

    t.equal(
        legal.exitCode,
        0,
        `set semantics: the field initializer assigns through the generated setter — legal.\n${commandOutput(legal)}`
    )
})

it("a consumer get/set PAIR over a mixin AUTO-ACCESSOR is a legal accessor-over-accessor override", async (t: Test) => {
    // Accessor over accessor is sound under both semantics (the auto-accessor's initializer
    // writes its own backing slot directly, never through the override) — the guard must NOT
    // misread the auto-accessor as a field and reject the pair.
    const define = await build(pairOverAutoAccessor, { useDefineForClassFields: true })

    t.equal(
        define.exitCode,
        0,
        `define semantics: accessor-over-accessor stays legal.\n${commandOutput(define)}`
    )

    const set = await build(pairOverAutoAccessor, { useDefineForClassFields: false })

    t.equal(
        set.exitCode,
        0,
        `set semantics: accessor-over-accessor stays legal.\n${commandOutput(set)}`
    )
})

it("a consumer AUTO-ACCESSOR over a mixin FIELD is rejected under BOTH semantics", async (t: Test) => {
    // Under define semantics this is the ordinary §2.14 hazard (the deeper field's own-property
    // define buries the accessor). Under SET semantics it is WORSE, unlike a hand-written pair:
    // the mixin field's constructor assignment fires the overriding setter while the
    // auto-accessor's private backing slot is not installed yet (that happens only after
    // super() returns) — a guaranteed TypeError at construction time.
    const define       = await build(autoAccessorOverField, { useDefineForClassFields: true })
    const defineOutput = commandOutput(define)

    t.ne(define.exitCode, 0, "define semantics: rejected")
    t.match(defineOutput, "TS990010", `the native guard fires under define semantics.\n${defineOutput}`)

    const set       = await build(autoAccessorOverField, { useDefineForClassFields: false })
    const setOutput = commandOutput(set)

    t.ne(set.exitCode, 0, "set semantics: rejected too — the private backing slot does not exist yet")
    t.match(setOutput, "TS990010", `the native guard fires under set semantics.\n${setOutput}`)
})

it("a @mixin FIELD over its DEPENDENCY's accessor is rejected under define semantics (parity with consumers)", async (t: Test) => {
    // The overriding class is itself a @mixin implementing the accessor-carrying one — the
    // mixin-expand path, not consumer-expand. The §2.14 guard must hold identically.
    const mixinOverDependency = trimIndent(`
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
        class Flat implements Measured {
            value: number = 5
        }

        void Flat
    `)

    const rejected = await build(mixinOverDependency, { useDefineForClassFields: true })
    const output   = commandOutput(rejected)

    t.ne(rejected.exitCode, 0, "define semantics: rejected on the mixin declaration too")
    t.match(output, "TS990010", `the native guard fires for a mixin-as-consumer.\n${output}`)
    t.match(output, "'value' is defined as an accessor in mixin Measured", "the message names the buried accessor")

    const legal = await build(mixinOverDependency, { useDefineForClassFields: false })

    t.equal(
        legal.exitCode,
        0,
        `set semantics: legal, exactly like the consumer case.\n${commandOutput(legal)}`
    )
})

it("a consumer overriding a mixin METHOD with a narrowed return still chains through super", async (t: Test) => {
    const result = await build(
        trimIndent(`
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
    `),
        { noImplicitOverride: true }
    )

    t.equal(
        result.exitCode,
        0,
        `an override with a narrowed return type + super chaining compiles (noImplicitOverride).\n${commandOutput(result)}`
    )
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
