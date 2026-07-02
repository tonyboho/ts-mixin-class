import path from "node:path"
import { pathToFileURL } from "node:url"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"

// The `moduleResolution: NodeNext` plane. Every other fixture in the suite runs under
// `Bundler`, where `impliedNodeFormat` is always undefined — the DocumentRegistry-key crash
// (tsserver-incremental-rebuild-crash.t.ts) proved the suite structurally blind to NodeNext.
// This is the EMIT side of that plane: a real `type: module` package with `.js` relative
// specifiers (the ts-serializable shape) must build through the printed-tree path (which
// re-creates source files and must preserve their `impliedNodeFormat`), type-check under
// `--noEmit` (the source-view path), and run.

const mixinText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class Tagger {
        tag(value: string): string {
            return "[" + value + "]"
        }
    }
`)

const consumerText = trimIndent(`
    import { Base } from "ts-mixin-class/base"
    import { Tagger } from "./mixin.js"

    export class Service extends Base implements Tagger {
        public id!: string

        describe(): string {
            return this.tag(this.id)
        }
    }

    export const made = Service.new({ id: "s1" }).describe()
`)

it("a NodeNext (type: module) package builds, type-checks and runs", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { module: "NodeNext", moduleResolution: "NodeNext", declaration: true },
        sourceFiles            : [
            { fileName: "mixin.ts", text: mixinText },
            { fileName: "consumer.ts", text: consumerText }
        ]
    })

    const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

    // Emit plane: the printed-tree path re-creates each transformed source file.
    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `NodeNext build succeeds.\n${commandOutput(build)}`)

    // Source-view plane: `--noEmit` selects the position-preserving tree.
    const check = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile, "--noEmit" ], fixture.directory)

    t.equal(check.exitCode, 0, `NodeNext --noEmit type-check succeeds.\n${commandOutput(check)}`)

    // Runtime: the emitted ESM actually runs.
    const moduleUrl = pathToFileURL(path.join(fixture.directory, "dist", "consumer.js")).href
    const imported  = await import(moduleUrl) as { made: string }

    t.equal(imported.made, "[s1]", "the NodeNext-built consumer constructs and runs its mixin member")

    // The fixture directory is left for the dynamic import to resolve (same policy as
    // nested-scope-declarations.t.ts); the OS temp dir is cleaned on process exit.
    void fixture
})
