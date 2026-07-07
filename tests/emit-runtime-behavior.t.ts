import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import { generatedStaticNewMarker } from "../src/construction-config.js"

// The emitted JS must RUN correctly: each test builds a fixture through the transformer,
// pins the emitted text, then dynamic-imports the output and asserts the runtime behaviour.

// The generated `static new` factory on a construction class only forwards to the inherited
// `Base.new`, so it is redundant JS. A `before` emit transformer strips it from the JS
// output (the runtime uses the inherited `Base.new`), while declaration emit keeps the typed
// `static new(props: <Class>Config): <Class>` so consumers still see the factory type.
const constructionClassText = `
import { Base } from "ts-mixin-class/base"

export class Account extends Base {
    public id!: string = ""
    public balance!: number = 0
    public label?: string
}

const account = Account.new({ id: "a1", balance: 100 })

export const constructedId = account.id
export const constructedBalance = account.balance
`

it("strips the redundant generated static new from JS emit but keeps it in declarations", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : [ { fileName: "source.ts", text: constructionClassText } ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.equal(result.exitCode, 0, `Construction class builds.\n${commandOutput(result)}`)

        const emittedJs   = await readFile(path.join(fixture.directory, "dist", "source.js"), "utf8")
        const declaration = await readFile(path.join(fixture.directory, "dist", "source.d.ts"), "utf8")

        // JS: the class is emitted, but its generated `static new` factory (and the strip
        // marker) are gone — `Account.new(...)` runs through the inherited `Base.new`.
        t.match(emittedJs, "class Account", "the construction class is still emitted")
        t.notMatch(emittedJs, "static new", "the generated static new factory is stripped from JS")
        t.notMatch(emittedJs, "super.new", "the forwarding `super.new(props)` body is gone")
        t.notMatch(emittedJs, generatedStaticNewMarker, "the internal strip marker never reaches the output")

        // Declarations: the typed factory survives so consumers keep `Account.new(...)`.
        t.match(declaration, "static new(props: AccountConfig): Account", "declaration keeps the typed static new")
        t.match(declaration, "AccountConfig", "declaration keeps the generated config alias")

        // Runtime: the stripped JS still constructs correctly via the inherited Base.new.
        const moduleUrl   = pathToFileURL(path.join(fixture.directory, "dist", "source.js")).href
        const constructed = await import(moduleUrl) as { constructedId: string, constructedBalance: number }

        t.equal(constructed.constructedId, "a1", "Account.new assigned the id at runtime (via inherited Base.new)")
        t.equal(constructed.constructedBalance, 100, "Account.new assigned the balance at runtime")
    } finally {
        await fixture.dispose()
    }
})

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
