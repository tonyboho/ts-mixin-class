import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// Required-base (and dependency) STATICS inside a mixin's own `static` body, reached through
// `super`. The factory's `base` parameter carries the base's static side (mirroring the
// source-view `$base` cast, which always did), so `super.<baseStatic>` type-checks on the EMIT
// plane too — and, symmetrically, an INCOMPATIBLE static override is TS2417 on BOTH planes
// (emit used to pass it silently: the bare `AnyConstructor<Instance>` base parameter had no
// statics to check the mixin's own statics against).

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

async function buildBothPlanes(text: string): Promise<{ emit: CommandResult, sourceView: CommandResult }> {
    const [ emit, sourceView ] = await Promise.all([ build(text), build(text, { noEmit: true }) ])

    return { emit, sourceView }
}

const requiredBaseStatics = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class Persisted {
        static hello(): string {
            return "hello"
        }

        static make(): Persisted {
            return new Persisted()
        }

        id: number = 0
    }

    @mixin()
    class Stored extends Persisted {
        key: string = ""

        static greetViaBase(): string {
            return super.hello()
        }

        static builder(): Persisted {
            return super.make()
        }
    }

    const stored     = new Stored()
    const viaStatic: string = Stored.greetViaBase()
    const built: Persisted  = Stored.builder()

    void [ stored, viaStatic, built ]
`)

it("a mixin's static reaches the required base's statics through super — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(requiredBaseStatics)

    t.equal(emit.exitCode, 0, `emit: super.<baseStatic> in a mixin static compiles.\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

const staticNewDelegation = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    class Titled extends Base {
        public title: string = ""

        static new(title: string): Titled {
            return super.new({ title }) as Titled
        }
    }

    const titled = Titled.new("spec")
    const read: string = titled.title

    void read
`)

it("a mixin's own 'static new' delegates to Base.new through super — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(staticNewDelegation)

    t.equal(emit.exitCode, 0, `emit: the super.new(...) delegation compiles.\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

const incompatibleStaticOverride = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class Tagged {
        static tag: string = "t"

        id: number = 0
    }

    @mixin()
    class Marked extends Tagged {
        static tag: number = 1

        flag: boolean = true
    }

    void Marked
`)

it("an INCOMPATIBLE static override on a mixin is TS2417 on both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(incompatibleStaticOverride)

    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: rejected (used to pass silently)")
    t.match(emitOutput, "TS2417", `the static-side extends check fires on emit too.\n${emitOutput}`)

    const sourceViewOutput = commandOutput(sourceView)

    t.ne(sourceView.exitCode, 0, "source view: rejected, as it always was")
    t.match(sourceViewOutput, "TS2417", `both planes agree on the code.\n${sourceViewOutput}`)
})

const dependencyStatics = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Counter {
        static origin(): string {
            return "counter"
        }

        count: number = 1
    }

    @mixin()
    class Doubler implements Counter {
        static originViaDep(): string {
            return super.origin()
        }

        double(): number {
            return this.count * 2
        }
    }

    const origin: string = Doubler.originViaDep()

    void origin
`)

it("a mixin's static reaches a DEPENDENCY's statics through super — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(dependencyStatics)

    t.equal(emit.exitCode, 0, `emit: super.<depStatic> in a mixin static compiles.\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})

const genericRequiredBaseStatics = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class Repo<T> {
        static kind(): string {
            return "repo"
        }

        value!: T
    }

    @mixin()
    class Cached<T> extends Repo<T> {
        cached: boolean = true

        static kindViaBase(): string {
            return super.kind()
        }

        read(): T {
            return this.value
        }
    }

    const kind: string = Cached.kindViaBase()

    void kind
`)

it("a GENERIC mixin's static reaches its generic required base's statics through super — both planes", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(genericRequiredBaseStatics)

    t.equal(emit.exitCode, 0, `emit: typeof GenericBase (the raw static side) rides the base parameter.\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})
