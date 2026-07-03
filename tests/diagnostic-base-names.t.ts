import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// The checker's own messages that embed a BASE-CLASS NAME are rewritten at the
// `wrapProgramDiagnostics` seam so they name what the USER wrote instead of a generated
// artifact (`__X$base`, `typeof __X$class`, `ClassStatics<typeof R>`) or a collapsed-position
// render (`'}'`, `'typeof }'`, the cast-intersection text). The diagnostic itself — code,
// span, substance — is the checker's, untouched; only the NAME inside the text is mapped
// back. The owner is resolved PRECISELY: the member at the diagnostic span is looked up
// through the class's mixin layers (C3, nearest first) and then the real base chain.

async function buildBothPlanes(
    text: string,
    compilerOptions: Record<string, unknown> = {}
): Promise<{ emit: CommandResult, sourceView: CommandResult }> {
    const run = async (extra: Record<string, unknown>): Promise<CommandResult> => {
        const fixture = await createTypeScriptFixture({
            experimentalDecorators : false,
            compilerOptions        : { ...compilerOptions, ...extra },
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

    return {
        emit       : await run({}),
        sourceView : await run({ noEmit: true })
    }
}

// The overridden member lives on the REAL base (`Machine`), not the mixin — the owner
// resolution must pick the base, even though the mixin layers sit closer to the class.
const realBaseOwner = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Greeter {
        greet(): string {
            return "hi"
        }
    }

    class Machine {
        run(): string {
            return "run"
        }
    }

    class Robot extends Machine implements Greeter {
        run(): string {
            return "running"
        }
    }

    void [ new Robot().run(), new Robot().greet() ]
`)

it("TS4114 over a REAL-base member names the base class, not the generated heritage", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(realBaseOwner, { noImplicitOverride: true })

    for (const [ label, result ] of [ [ "emit", emit ], [ "source view", sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${label}: the unmarked override is rejected`)
        t.match(output, "TS4114", `${label}: with the override-modifier demand`)
        t.match(output, "base class 'Machine'", `${label}: naming the real base that owns run().\n${output}`)
        t.notMatch(output, "$base", `${label}: no generated base name leaks`)
        t.notMatch(output, "base class '}'", `${label}: no collapsed-position render leaks`)
        t.notMatch(output, "Machine & Greeter", `${label}: no cast-intersection text leaks`)
    }
})

// TS4113: the marked member exists in NO layer, so there is no owner to name — the message
// falls back to the user-level description of the combined base (here the single mixin).
const notInBase = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Greeter {
        greet(): string {
            return "hi"
        }
    }

    class Solo implements Greeter {
        override notInBase(): string {
            return "x"
        }
    }

    void new Solo().greet()
`)

it("TS4113 (member not in the base) falls back to the user-level combined-base name", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(notInBase, { noImplicitOverride: true })

    for (const [ label, result ] of [ [ "emit", emit ], [ "source view", sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${label}: the stray override marker is rejected`)
        t.match(output, "TS4113", `${label}: with the not-declared-in-base code`)
        t.match(output, "base class 'Greeter'", `${label}: naming the combined base in user terms.\n${output}`)
        t.notMatch(output, "$base", `${label}: no generated base name leaks`)
        t.notMatch(output, "base class '}'", `${label}: no collapsed-position render leaks`)
    }
})

// A construction class declared in a NESTED scope keeps its generated `<Name>Config` alias
// INSIDE the block (a top-level alias is appended as real text past the document end, where
// its name renders natively; inside a block that would shift positions), so a source-view
// message that prints the alias SYMBOL — e.g. TS2315 `Type '{0}' is not generic` — renders
// the collapsed name as `'}'`, while emit prints the real `'PointConfig'`. The span sits on
// the user's own alias reference, so the original text at the span IS the real name.
const nestedAliasSymbolMessage = trimIndent(`
    import { Base } from "ts-mixin-class/base"

    const make = () => {
        class Point extends Base {
            public readonly x!: number

            override initialize(config?: PointConfig<number>): void {
                super.initialize(config)
            }
        }

        return Point.new({ x : 1 })
    }

    void make()
`)

it("a message printing a NESTED class's config-alias symbol names the alias, not the collapsed '}'", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(nestedAliasSymbolMessage)

    for (const [ label, result ] of [ [ "emit", emit ], [ "source view", sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${label}: the type-argument misuse is rejected`)
        t.match(output, "TS2315", `${label}: with the not-generic code`)
        t.match(output, "Type 'PointConfig' is not generic", `${label}: naming the config alias.\n${output}`)
        t.notMatch(output, "'}'", `${label}: no collapsed-position render leaks`)
    }
})

// TS2416 fires TWICE by construction: once against the user's own `implements Greeter`
// reference (correct name) and once against the generated heritage (artifact name). The
// rewrite maps the artifact twin onto the same user-level name, which makes the two
// byte-identical — and the seam dedup collapses them to ONE diagnostic.
const incompatibleMember = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Greeter {
        greet(): string {
            return "hi"
        }
    }

    class Bad implements Greeter {
        greet(): number {
            return 1
        }
    }

    void Bad
`)

it("the TS2416 artifact twin is renamed onto the user's mixin and deduped away", async (t: Test) => {
    const { emit, sourceView } = await buildBothPlanes(incompatibleMember)

    for (const [ label, result ] of [ [ "emit", emit ], [ "source view", sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${label}: the incompatible member is rejected`)
        t.match(output, "base type 'Greeter'", `${label}: naming the mixin.\n${output}`)
        t.notMatch(output, "$base", `${label}: no generated base name leaks`)
        t.notMatch(output, "base type '}'", `${label}: no collapsed-position render leaks`)
        t.is(output.split("TS2416").length - 1, 1,
            `${label}: exactly ONE TS2416 remains after the artifact twin is renamed and deduped`)
    }
})
