import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
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

// NB construction tracking ends at a manual `.mix` application — BY DESIGN (USE-CASES §9.2):
// a class extending `M.mix(BaseDescendant)` keeps the inherited `BaseDescendant.new`. Manual
// `.mix` is the escape hatch for non-transformer consumers ONLY — program-local `.mix` is
// banned outright (TS990012, `manual-mix-ban.t.ts`); the construction-enabled form is
// `class X extends BaseDescendant implements M`.

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

    t.equal(
        result.exitCode,
        0,
        `a barrel-imported construction-base mixin keeps the consumer construction-enabled.\n${commandOutput(result)}`
    )
})
