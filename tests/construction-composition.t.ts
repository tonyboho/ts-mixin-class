import path from "node:path"

import { it, xit } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

// Construction (§7) composed with the OTHER application shapes: a manual `.mix(...)` over a
// `Base` descendant, and a construction-base mixin imported through a re-export barrel
// (§10.1c × §7). Both must stay construction-enabled: `.new({ … })` aggregates the config and
// the direct-`new` ban holds.

async function build(files: TypeScriptFixtureSourceFile[]): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : files
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

// SKIPPED (xit) — decided-deferred spec point (see TODO.md "Construction through a manual
// .mix heritage"). A class extending `M.mix(BaseDescendant)` is NOT construction-recognized:
// `isConstructionBaseOptIn` bails on a non-Identifier extends expression, so the class keeps
// the inherited `BaseDescendant.new` — no own `.new`/`<Name>Config`, no mixin fields, no own
// fields in the config.
xit("a manual .mix over a Base descendant stays construction-enabled", async (t: Test) => {
    const result = await build([ {
        fileName : "source.ts",
        text     : trimIndent(`
            import { mixin } from "ts-mixin-class"
            import { Base } from "ts-mixin-class/base"

            @mixin()
            class Tagged {
                public tag: string = "t"
            }

            class Model extends Base {
                public id!: string
            }

            class TaggedModel extends Tagged.mix(Model) {
                public score: number = 0
            }

            const built = TaggedModel.new({ id: "m1", tag: "custom", score: 5 })

            const id: string     = built.id
            const tag: string    = built.tag
            const score: number  = built.score

            // @ts-expect-error direct construction is banned on a construction class
            new TaggedModel()

            // @ts-expect-error the required id is still required through the manual mix
            TaggedModel.new({})

            void [ id, tag, score ]
        `)
    } ])

    t.equal(result.exitCode, 0,
        `a manual .mix over a Base descendant keeps .new with aggregated config.\n${commandOutput(result)}`)
})

it("a construction-base mixin imported through a re-export barrel stays construction-enabled", async (t: Test) => {
    const result = await build([
        {
            fileName : "record.ts",
            text     : trimIndent(`
                import { mixin } from "ts-mixin-class"
                import { Base } from "ts-mixin-class/base"

                @mixin()
                export class Record extends Base {
                    public key!: string
                }
            `)
        },
        {
            fileName : "barrel.ts",
            text     : `export { Record } from "./record"\n`
        },
        {
            fileName : "source.ts",
            text     : trimIndent(`
                import { Record } from "./barrel"

                export class Entry implements Record {
                    public value: number = 0
                }

                const entry = Entry.new({ key: "k1", value: 3 })

                const key: string    = entry.key
                const value: number  = entry.value

                // @ts-expect-error the mixin's required config key holds through the barrel
                Entry.new({ value: 1 })

                void [ key, value ]
            `)
        }
    ])

    t.equal(result.exitCode, 0,
        `a barrel-imported construction-base mixin keeps the consumer construction-enabled.\n${commandOutput(result)}`)
})
