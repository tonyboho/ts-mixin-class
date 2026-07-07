import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, openTsServerSession, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"

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
        public id!: string = ""
        public balance!: number = 0
        public label?: string

        override initialize(config?: AccountConfig): void {
            super.initialize(config)
        }
    }

    const accountConfig: AccountConfig = { id : "a2", balance : 50 }
    const account = Account.new({ id : "a1", balance : 100 })

    class Box<T> extends Base {
        public value!: T
        public tag!: string = ""

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
type SignatureItemsBody = { items?: Array<{ prefixDisplayParts?: Array<{ text: string }> }> }

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
        { file: sourceFile, ...positionToLineOffset(aliasUsageText, position) }
    )
}

it("tsserver go-to-definition on a config-alias reference resolves into the owning class without crashing", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: aliasUsageText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        for (const { name, alias, marker, owner, after } of [
            { name: "AccountConfig", alias: "AccountConfig", marker: "config?: AccountConfig", owner: "class Account", after: "const accountConfig" },
            { name: "AccountConfig (annotation)", alias: "AccountConfig", marker: "accountConfig: AccountConfig", owner: "class Account", after: "const accountConfig" },
            { name: "BoxConfig", alias: "BoxConfig", marker: "config?: BoxConfig<T>", owner: "class Box", after: "const box" }
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
        sourceFiles            : [ { fileName: "source.ts", text: aliasUsageText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        const accountInfo    = assertResponseBody<QuickInfoBody>(
            t,
            await aliasRequest(fixture.directory, sourceFile, "quickinfo", "config?: AccountConfig", "AccountConfig")
        )
        const accountDisplay = accountInfo.displayString ?? ""
        // The config flattens its required+optional intersection through a homomorphic mapped type,
        // so quickinfo resolves to the actual field shape (required `balance`, optional `label?`)
        // rather than an opaque `Pick<...> & Partial<...>`.
        t.true(
            accountDisplay.includes("balance") && accountDisplay.includes("label?"),
            `Quickinfo on AccountConfig resolves to its field shape, got:\n${accountDisplay}`
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
        sourceFiles            : [ { fileName: "source.ts", text: aliasUsageText } ]
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
        sourceFiles            : [ { fileName: "source.ts", text: aliasUsageText } ]
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

// A construction class declared in a NESTED scope keeps its generated `<Name>Config` alias
// INSIDE the block — the append-real-text trick works only past the document end, and inside
// a block it would shift positions — so the alias declaration hover would print the collapsed
// name: `type } = {...}`. The hovered token IS the alias reference, so the language-service
// plugin substitutes its text into the collapsed `aliasName` display part.
const nestedAliasHoverText = trimIndent(`
    import { Base } from "ts-mixin-class/base"

    const make = () => {
        class Point extends Base {
            public readonly x!: number

            override initialize(config?: PointConfig): void {
                super.initialize(config)
            }
        }

        return Point.new({ x : 1 })
    }

    void make()
`)

it("tsserver quickinfo on a NESTED class's config-alias reference names the alias, not the collapsed `}`", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: nestedAliasHoverText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const marker     = "config?: PointConfig"
        const position   = nestedAliasHoverText.indexOf(marker) + marker.indexOf("PointConfig") + 1

        const info    = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                nestedAliasHoverText,
                "quickinfo",
                { file: sourceFile, ...positionToLineOffset(nestedAliasHoverText, position) }
            )
        )
        const display = info.displayString ?? ""

        t.match(
            display,
            "type PointConfig =",
            `Hover on the nested config alias names it, got:\n${display}`
        )
        t.notMatch(
            display,
            "type } =",
            "The collapsed-position render never surfaces in the hover"
        )
    } finally {
        await fixture.dispose()
    }
})

// The generated `static new`'s NAME node is pinned to a ONE-CHAR source anchor (a real span
// is load-bearing: a factory-fresh name crashes the checker's error-span machinery on a
// failing `.new(...)` call), so every editor surface that prints a member name from SOURCE
// TEXT renders that one garbage character instead — `TopPoint.r`, `Timed[0]`, `Point[}]` —
// on quickinfo, signature help and completion details alike. The language-service plugin
// normalizes the name back to `new` (each request is gated on actually targeting `new`).
const newNameRenderText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Timed extends Base {
        public delay!: number = 0
    }

    class TopPoint extends Base implements Timed {
        public readonly x!: number
    }

    const tp = TopPoint.new({ x : 1, delay : 2 })
    const tm = Timed.new({ delay : 2 })

    const make = () => {
        class Point extends Base {
            public readonly y!: number
        }

        return Point.new({ y : 2 })
    }

    void [ tp, tm, make() ]
`)

it("tsserver renders the generated `.new` NAME as `new` on quickinfo, signature help and completion details", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: newNameRenderText } ]
    })
    const session = openTsServerSession(fixture.directory)

    try {
        const file = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        await session.open(file, newNameRenderText)

        const at = (marker: string, inner: string): { line: number, offset: number } =>
            positionToLineOffset(newNameRenderText, newNameRenderText.indexOf(marker) + marker.indexOf(inner) + 1)

        // --- quickinfo on `.new`: consumer (top-level), mixin value-cast, nested consumer ---
        for (const { label, marker, expected } of [
            { label: "top-level consumer", marker: "TopPoint.new({ x", expected: "TopPoint.new(props" },
            { label: "mixin",              marker: "Timed.new({ delay", expected: "Timed.new(props" },
            { label: "nested consumer",    marker: "Point.new({ y",     expected: "Point.new(props" }
        ]) {
            const info    = assertResponseBody<QuickInfoBody>(
                t,
                await session.request("quickinfo", { file, ...at(marker, "new") })
            )
            const display = info.displayString ?? ""

            t.match(display, expected, `${label}: quickinfo names the method \`new\`, got:\n${display}`)
        }

        // --- signature help inside `.new(`: the prefix leads with the real name ---
        const sigPosition = newNameRenderText.indexOf("TopPoint.new({ x") + "TopPoint.new(".length + 1
        const signatures  = assertResponseBody<SignatureItemsBody>(
            t,
            await session.request("signatureHelp", {
                file,
                ...positionToLineOffset(newNameRenderText, sigPosition)
            })
        )
        const prefix      = (signatures.items?.[0]?.prefixDisplayParts ?? []).map((part) => part.text).join("")

        t.is(prefix, "new(", "signature help leads with `new(`, not the one-char anchor render")

        // --- completion entry details for `new` ---
        const details    = assertResponseBody<Array<{ displayParts?: Array<{ text: string }> }>>(
            t,
            await session.request("completionEntryDetails", {
                file,
                ...at("TopPoint.new({ x", "new"),
                entryNames : [ "new" ]
            })
        )
        const detailText = (details[0]?.displayParts ?? []).map((part) => part.text).join("")

        t.match(detailText, "TopPoint.new(props", `completion details name the method \`new\`, got:\n${detailText}`)
    } finally {
        await session.close()
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
        public a!: string = ""

        override initialize(config?: AConfig): void {
            super.initialize(config)
        }
    }

    @mixin()
    class B extends Base {
        public b!: number = 0

        override initialize(config?: BConfig): void {
            super.initialize(config)
        }
    }

    class C extends Base implements A, B {
        public c!: boolean = false
    }

    const created = C.new({ a : "x", b : 1, c : true })
    void created
`)

// The diagnostics-plane siblings (no TS2320 / merged-config requirements / static-side
// cleanliness / the alias named in failing `.new(...)` messages) live in
// `tsserver-diagnostics.t.ts` — this file owns the NAVIGATION surface of the alias.

it("tsserver rename on a mixin's initialize override responds instead of crashing the checker", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: initializeOverrideText } ]
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
                { file: sourceFile, ...positionToLineOffset(initializeOverrideText, position) }
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

// In source view the transform appends each generated `<Name>Config` alias as REAL text past
// the document end so its name renders natively (diagnostics / hover / quickinfo). That tail
// is LIVE for the language service, so the companion `language-service-plugin` (wired into the
// fixture tsconfig, see `createTsconfig`) must hide it from navigation:
//   - find-references returns NO span past the on-disk document (the appended `Pick<Account,…>`
//     references the class/fields — those phantom hits must be dropped);
//   - go-to-definition on the alias REMAPS onto the owning class' name (not the phantom tail,
//     and not nothing).

const navigationTailText = trimIndent(`
    import { Base } from "ts-mixin-class/base"

    class Account extends Base {
        public id!: string = ""
        public balance!: number = 0

        override initialize(config?: AccountConfig): void {
            super.initialize(config)
        }
    }

    const bad = Account.new({ id : "x" })
    const ok = Account.new({ id : "x", balance : 1 })
    void [ bad, ok ]
`)

const navigationTailLineCount = navigationTailText.split("\n").length

type RefBody = { refs?: Array<{ file: string, start: { line: number, offset: number } }> }
type DefBody = Array<{ file: string, start: { line: number, offset: number } }>

it("editor names the config alias natively and the ls-plugin keeps its appended text out of navigation", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: navigationTailText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const session    = openTsServerSession(fixture.directory)

        await session.open(sourceFile, navigationTailText)

        // The failing `.new(...)` diagnostic names the alias NATIVELY (real appended text).
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await session.request("semanticDiagnosticsSync", { file: sourceFile })
        )
        const diagText    = diagnostics.map((d) => d.text ?? "").join("\n")

        t.match(diagText, "AccountConfig", "diagnostic names the alias natively")
        t.notMatch(diagText, "parameter of type '}'", "no meaningless `}` config type")

        // find-references on the class name returns NO phantom span past the on-disk document.
        const accountPosition = navigationTailText.indexOf("class Account") + "class ".length + 1
        const references      = assertResponseBody<RefBody>(
            t,
            await session.request("references", { file: sourceFile, ...positionToLineOffset(navigationTailText, accountPosition) })
        )
        const referenceLines  = (references.refs ?? []).map((reference) => reference.start.line)

        t.ne(referenceLines.length, 0, "references are found")
        t.true(
            referenceLines.every((line) => line <= navigationTailLineCount),
            `no reference past the on-disk document (lineCount=${navigationTailLineCount}, got ${JSON.stringify(referenceLines)})`
        )

        // go-to-definition on the alias reference REMAPS onto the owning class' name.
        const aliasUse   = navigationTailText.indexOf("config?: AccountConfig") + "config?: ".length + 1
        const definition = assertResponseBody<DefBody>(
            t,
            await session.request("definition", { file: sourceFile, ...positionToLineOffset(navigationTailText, aliasUse) })
        )
        const classLine  = positionToLineOffset(navigationTailText, navigationTailText.indexOf("class Account")).line

        t.eq(
            definition.map((entry) => entry.start.line),
            [ classLine ],
            "go-to-definition on the alias lands on the owning class, not the appended tail"
        )

        await session.close()
    } finally {
        await fixture.dispose()
    }
})
