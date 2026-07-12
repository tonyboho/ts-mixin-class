import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// RESERVED companion-type names. `<ClassName>Config` (and `<ClassName>ConfigMeta`) are the
// generated construction companions of every construction-enabled class — a user declaration
// or import colliding with them is rejected with a clean native diagnostic (TS990015), never
// silently suffixed (the pre-epic `ModelConfig_` fallback is gone). This is the `static mix`
// reservation (§11.12) applied to the config type namespace: the companion name stays
// DERIVABLE from the class name, so cross-file alias-route resolution never needs discovery.
// Where no companion is generated (a non-construction class, a user-owned `static new`),
// nothing is reserved.

async function build(
    files: { fileName: string, text: string }[],
    compilerOptions?: Record<string, unknown>
): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
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

const configCollision = trimIndent(`
    import { Base } from "ts-mixin-class"

    type ModelConfig = { custom : string }

    export class Model extends Base {
        public id!: string
    }

    const user: ModelConfig = { custom : "x" }
    void user
`)

it("a user type colliding with the reserved '<ClassName>Config' name is rejected in both planes", async (t: Test) => {
    const emit       = await build([ { fileName: "source.ts", text: configCollision } ])
    const emitOutput = commandOutput(emit)

    t.ne(emit.exitCode, 0, "emit: rejected")
    t.match(emitOutput, "TS990015", `a native diagnostic, not a raw duplicate.\n${emitOutput}`)
    t.match(emitOutput, "'ModelConfig' is reserved", "the message names the reserved companion")
    t.match(emitOutput, "Model", "the message names the owning construction class")
    t.notMatch(emitOutput, "TS2300", "no raw duplicate-identifier noise")

    const sourceView       = await build([ { fileName: "source.ts", text: configCollision } ], { noEmit: true })
    const sourceViewOutput = commandOutput(sourceView)

    t.ne(sourceView.exitCode, 0, "source view: rejected identically")
    t.match(sourceViewOutput, "'ModelConfig' is reserved", `both planes agree.\n${sourceViewOutput}`)
})

it("a user interface colliding with the reserved '<ClassName>ConfigMeta' name is rejected", async (t: Test) => {
    const result = await build([ {
        fileName : "source.ts",
        text     : trimIndent(`
            import { Base } from "ts-mixin-class"

            interface WidgetConfigMeta {
                marker : boolean
            }

            export class Widget extends Base {
                public label!: string
            }

            const meta: WidgetConfigMeta = { marker : true }
            void meta
        `)
    } ])
    const output = commandOutput(result)

    t.ne(result.exitCode, 0, "rejected")
    t.match(output, "TS990015", `the ConfigMeta companion name is reserved too.\n${output}`)
    t.match(output, "'WidgetConfigMeta' is reserved", "the message names the reserved companion")
})

it("an import colliding with the reserved config alias name is rejected", async (t: Test) => {
    const result = await build([
        {
            fileName : "types.ts",
            text     : trimIndent(`
                export type ModelConfig = { custom : string }
            `)
        },
        {
            fileName : "source.ts",
            text     : trimIndent(`
                import { Base } from "ts-mixin-class"
                import type { ModelConfig } from "./types.js"

                export class Model extends Base {
                    public id!: string
                }

                const user: ModelConfig = { custom : "x" }
                void user
            `)
        }
    ])
    const output = commandOutput(result)

    t.ne(result.exitCode, 0, "rejected")
    t.match(output, "TS990015", `an imported binding shadows the companion the same way.\n${output}`)
    t.match(output, "'ModelConfig' is reserved", "the message names the reserved companion")
})

it("a NON-construction class reserves nothing — the user's '<ClassName>Config' type is legal", async (t: Test) => {
    const result = await build([ {
        fileName : "source.ts",
        text     : trimIndent(`
            type ModelConfig = { custom : string }

            export class Model {
                public id: string = ""
            }

            const user: ModelConfig = { custom : "x" }
            void user
        `)
    } ])

    t.equal(result.exitCode, 0, `no construction machinery, nothing reserved.\n${commandOutput(result)}`)
})

it("a user-owned 'static new' suppresses the companion — the user's config type is legal", async (t: Test) => {
    const result = await build([ {
        fileName : "source.ts",
        text     : trimIndent(`
            import { Base } from "ts-mixin-class"

            type DocumentConfig = { title : string }

            export class Document extends Base {
                public title: string = ""

                static new(config: DocumentConfig): Document {
                    return super.new(config) as Document
                }
            }

            const doc = Document.new({ title : "spec" })
            void doc
        `)
    } ])

    t.equal(
        result.exitCode,
        0,
        `the user owns construction, so no companion is generated and nothing collides.\n${commandOutput(result)}`
    )
})

it("a construction MIXIN's config alias name is reserved the same way", async (t: Test) => {
    const result = await build([ {
        fileName : "source.ts",
        text     : trimIndent(`
            import { Base, mixin } from "ts-mixin-class"

            type SortableConfig = { custom : string }

            @mixin()
            export class Sortable extends Base {
                public order!: number
            }

            const user: SortableConfig = { custom : "x" }
            void user
        `)
    } ])
    const output = commandOutput(result)

    t.ne(result.exitCode, 0, "rejected")
    t.match(output, "TS990015", `the mixin's companion alias is reserved too.\n${output}`)
    t.match(output, "'SortableConfig' is reserved", "the message names the reserved companion")
})
