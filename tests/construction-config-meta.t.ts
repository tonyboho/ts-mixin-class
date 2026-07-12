import path from "node:path"
import { readFile, readdir } from "node:fs/promises"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { commandOutput, createSourceFile, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"

// The `<ClassName>ConfigMeta` companion (pure-type-composition epic, decision 4): an
// exported, EMIT-PLANE-ONLY alias of literal fields carrying the residual construction
// facts a downstream transform cannot re-derive from the config TYPE alone —
// machine-readable by a trivial field/literal reader AND checker-addressable (the literal
// unions plug straight into `Required<Pick<…>>`). Source view never emits it (`.d.ts`
// files are not transformed, so the meta only needs to exist in declaration emit).
// Coherence meta ↔ config is by construction — both derive from the same aggregated
// property list; the `.d.ts` test below is the shape pin.

const modelText = `
    import { Base } from "ts-mixin-class/base"

    export class Model extends Base {
        public id!: string
        public opt: number = 0
    }
`

it("emits an exported <ClassName>ConfigMeta with literal construction facts", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(modelText)))

    t.match(printed, "export type ModelConfigMeta =", "the meta companion is a sibling exported alias")
    t.match(printed, "readonly requiresArgument: true", "a required key makes the `.new` argument required — as a literal")
    t.match(printed, 'readonly requiredKeys: "id"', "required keys ride as a literal union")
    t.match(printed, 'readonly keys: "id" | "opt"', "the full known-key list rides as a literal union")
    t.match(printed, "readonly indexKinds: never", "no index signatures — the literal says so")
})

it("an all-optional config yields requiresArgument: false and an empty required union", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        export class Loose extends Base {
            public opt: number = 0
        }
    `)))

    t.match(printed, "export type LooseConfigMeta =", "the meta companion is emitted")
    t.match(printed, "readonly requiresArgument: false", "an all-optional config keeps `.new()` callable bare")
    t.match(printed, "readonly requiredKeys: never", "no required keys — the union is never")
})

it("a NON-exported construction class gets no meta companion", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Internal extends Base {
            public id!: string
        }

        void Internal
    `)))

    t.match(printed, "type InternalConfig =", "the config alias stays (the static new references it)")
    t.notMatch(printed, "InternalConfigMeta", "no meta — nothing can import a module-local companion, and the dangling alias would be a TS6196 under noUnusedLocals")
})

it("source view never carries the meta companion", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(modelText), { sourceView: true }))

    t.notMatch(printed, "ConfigMeta", "the meta is emit-plane-only")
})

// The semicolon after `= false` is LOAD-BEARING source syntax, not style: a class member
// starting with `[` after an initializer otherwise parses as an element access on the
// initializer (`false[bag]`) — plain TypeScript, no transform involved.
it("exotic keys and index signatures ride the meta through declaration emit", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : [ {
            fileName : "exotic.ts",
            text     : `
                import { Base } from "ts-mixin-class/base"

                export const exoticKey: unique symbol = Symbol("exoticKey")

                export class Exotic extends Base {
                    public id!: string
                    public [exoticKey]!: number
                    public 0: boolean = false;
                    [bag: string]: unknown
                }
            `
        } ]
    })

    try {
        const build = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.isStrict(build.exitCode, 0, `the exotic construction class builds:\n${commandOutput(build)}`)

        const distDirectory = path.join(fixture.directory, "dist")
        const declaration   = await readFile(
            path.join(distDirectory, (await readdir(distDirectory)).find((name) => name.endsWith(".d.ts")) ?? ""),
            "utf8"
        )

        t.match(declaration, "export type ExoticConfigMeta =", "the meta rides the published declaration")
        t.match(declaration, "typeof exoticKey", "a computed unique-symbol key stays a type query in the unions")
        t.match(declaration, 'readonly indexKinds: "string"', "the index-signature kind is recorded")
    } finally {
        await fixture.dispose()
    }
})

// EMIT plane deliberately (a full `tsc -p` build): the meta is an INTERNAL, emit-plane-only
// artifact — a same-program source-view (`--noEmit`/IDE) reference to it does not resolve,
// by design. The epic's composition only ever references a meta ACROSS a package boundary,
// where it lives in the already-emitted `.d.ts` and both planes read the same text.
it("the meta unions are checker-addressable against the config alias", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "model.ts", text: modelText },
            {
                fileName : "meta-use.ts",
                text     : `
                    import { Model } from "./model.js"
                    import type { ModelConfig, ModelConfigMeta } from "./model.js"

                    // The literal unions plug straight into mapped/utility types.
                    type ReRequired = Required<Pick<ModelConfig, ModelConfigMeta["requiredKeys"]>>

                    const ok: ReRequired = { id : "x" }

                    // @ts-expect-error the re-required key set enforces its members
                    const missing: ReRequired = {}

                    const flag: ModelConfigMeta["requiresArgument"] = true

                    // @ts-expect-error requiresArgument is the literal true, not boolean
                    const wrong: ModelConfigMeta["requiresArgument"] = false

                    void [ Model, ok, missing, flag, wrong ]
                `
            }
        ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.isStrict(result.exitCode, 0, `type-level meta consumption typechecks in the emit plane:\n${commandOutput(result)}`)
    } finally {
        await fixture.dispose()
    }
})
