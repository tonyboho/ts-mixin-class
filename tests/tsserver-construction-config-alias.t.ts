import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"

// Editor-service behaviour on the generated, source-referenced `<ClassName>Config`
// alias. The alias is a synthetic sibling whose `.original` points at the unbound
// source-view clone class; a user reference to it (`initialize(config?: AccountConfig)`)
// must NOT make go-to-definition / quickinfo / find-references / rename walk
// `getParseTreeNode` into that clone and crash the checker. The alignment pass clears the
// alias's `Synthesized` flag so it resolves to itself instead. At minimum every request
// responds without a server error; we also assert the responses are sensible (quickinfo
// shows the expanded config type, definition resolves into the owning class).

const aliasUsageText = trimIndent(`
    import { Base } from "ts-mixin-class/base"

    class Account extends Base {
        public id: string = ""
        public balance: number = 0
        public label?: string

        override initialize(config?: AccountConfig): void {
            super.initialize(config)
        }
    }

    const accountConfig: AccountConfig = { id : "a2", balance : 50 }
    const account = Account.new({ id : "a1", balance : 100 })

    class Box<T> extends Base {
        public value!: T
        public tag: string = ""

        override initialize(config?: BoxConfig<T>): void {
            super.initialize(config)
        }
    }

    const box = Box.new<number>({ value : 1, tag : "n" })

    void [ accountConfig, account, box ]
`)

type DefinitionInfo = { file: string, start: { line: number, offset: number } }
type QuickInfoBody = { displayString?: string }
type RenameBody = { info?: { canRename?: boolean } }

// Resolves the position of the ALIAS NAME inside `marker` (the markers embed the alias
// name, e.g. `config?: AccountConfig`), one char into the identifier so the request lands
// squarely on the reference.
async function aliasRequest(
    directory: string,
    sourceFile: string,
    command: string,
    marker: string,
    aliasName: string
): Promise<ReturnType<typeof runTypeScriptServerRequest>> {
    const position = aliasUsageText.indexOf(marker) + marker.indexOf(aliasName) + 1

    return runTypeScriptServerRequest(
        directory,
        sourceFile,
        aliasUsageText,
        command,
        { file : sourceFile, ...positionToLineOffset(aliasUsageText, position) }
    )
}

it("tsserver go-to-definition on a config-alias reference resolves into the owning class without crashing", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : aliasUsageText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        for (const { name, alias, marker, owner, after } of [
            { name : "AccountConfig", alias : "AccountConfig", marker : "config?: AccountConfig", owner : "class Account", after : "const accountConfig" },
            { name : "AccountConfig (annotation)", alias : "AccountConfig", marker : "accountConfig: AccountConfig", owner : "class Account", after : "const accountConfig" },
            { name : "BoxConfig", alias : "BoxConfig", marker : "config?: BoxConfig<T>", owner : "class Box", after : "const box" }
        ]) {
            const definitions = assertResponseBody<DefinitionInfo[]>(
                t,
                await aliasRequest(fixture.directory, sourceFile, "definition", marker, alias)
            )

            // The alias is anchored at the owning class's `declaration.end` (its closing
            // brace), so its definition lands on a line within the class declaration - from
            // the `class X` line up to the first statement after the class body.
            const ownerStart = positionToLineOffset(aliasUsageText, aliasUsageText.indexOf(owner)).line
            const ownerEnd   = positionToLineOffset(aliasUsageText, aliasUsageText.indexOf(after)).line

            t.true(
                definitions.length > 0 &&
                    definitions.every((definition) => definition.file === sourceFile) &&
                    definitions.some((definition) => definition.start.line >= ownerStart && definition.start.line <= ownerEnd),
                `Definition of ${name} resolves into its owning class (${owner}) in the same file`
            )
        }
    } finally {
        await fixture.dispose()
    }
})

it("tsserver quickinfo on a config-alias reference shows the expanded config type without crashing", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : aliasUsageText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        const accountInfo = assertResponseBody<QuickInfoBody>(
            t,
            await aliasRequest(fixture.directory, sourceFile, "quickinfo", "config?: AccountConfig", "AccountConfig")
        )
        t.true(
            (accountInfo.displayString ?? "").includes("Pick<Account"),
            "Quickinfo on AccountConfig expands to the public-only config Pick over Account"
        )

        const boxInfo = assertResponseBody<QuickInfoBody>(
            t,
            await aliasRequest(fixture.directory, sourceFile, "quickinfo", "config?: BoxConfig<T>", "BoxConfig")
        )
        t.true(
            (boxInfo.displayString ?? "").includes("tag"),
            "Quickinfo on the generic BoxConfig resolves to its config shape"
        )
    } finally {
        await fixture.dispose()
    }
})

it("tsserver rename on a config-alias reference responds instead of crashing the checker", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : aliasUsageText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        for (const marker of [ "config?: AccountConfig", "config?: BoxConfig<T>" ]) {
            const body = assertResponseBody<RenameBody>(
                t,
                await aliasRequest(fixture.directory, sourceFile, "rename", marker, marker.includes("Box") ? "BoxConfig" : "AccountConfig")
            )

            t.true(
                body.info !== undefined,
                `Rename on ${marker.includes("Box") ? "BoxConfig" : "AccountConfig"} responds with rename info instead of crashing`
            )
        }
    } finally {
        await fixture.dispose()
    }
})

it("tsserver find-all-references on a config-alias reference responds instead of crashing the checker", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : aliasUsageText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        const body = assertResponseBody<{ refs?: unknown[] }>(
            t,
            await aliasRequest(fixture.directory, sourceFile, "references", "config?: AccountConfig", "AccountConfig")
        )

        t.true(
            Array.isArray(body.refs) && body.refs.length > 0,
            "Find-all-references on AccountConfig returns its reference set instead of crashing the checker"
        )
    } finally {
        await fixture.dispose()
    }
})

// A consumer applying several mixins that each override `initialize` with their own
// strict config. In the editor (source view) the generated `$base` interface re-declares
// the `Base.initialize` protocol member to suppress the TS2320 merge conflict; that
// member is synthetic, so rename/definition on a user `initialize` must not crash.
const initializeOverrideText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class A extends Base {
        public a: string = ""

        override initialize(config?: AConfig): void {
            super.initialize(config)
        }
    }

    @mixin()
    class B extends Base {
        public b: number = 0

        override initialize(config?: BConfig): void {
            super.initialize(config)
        }
    }

    class C extends Base implements A, B {
        public c: boolean = false
    }

    const created = C.new({ a : "x", b : 1, c : true })
    void created
`)

it("tsserver reports no TS2320 in the editor for a consumer of mixins overriding initialize", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : initializeOverrideText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                initializeOverrideText,
                "semanticDiagnosticsSync",
                { file : sourceFile }
            )
        )

        t.notOk(
            diagnostics.some((diagnostic) => diagnostic.code === 2320),
            "The construction consumer's generated base interface does not raise a TS2320 initialize merge conflict"
        )
    } finally {
        await fixture.dispose()
    }
})

it("tsserver rename on a mixin's initialize override responds instead of crashing the checker", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : initializeOverrideText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const marker     = "override initialize(config?: AConfig)"
        const position   = initializeOverrideText.indexOf(marker) + "override ".length + 1

        const body = assertResponseBody<{ info?: { canRename?: boolean } }>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                initializeOverrideText,
                "rename",
                { file : sourceFile, ...positionToLineOffset(initializeOverrideText, position) }
            )
        )

        t.true(
            body.info !== undefined,
            "Rename on a mixin's initialize override responds with rename info instead of crashing the synthetic protocol member"
        )
    } finally {
        await fixture.dispose()
    }
})
