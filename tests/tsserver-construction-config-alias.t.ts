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

it("tsserver reports no TS2320 in the editor for a consumer of mixins overriding initialize", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: initializeOverrideText } ]
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
                { file: sourceFile }
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

// A construction mixin that applies several initialize-overriding mixins WITHOUT its own
// override. Its generated `__Combined$base` interface extends Base + the mixins and gets
// the protocol member injected; in the editor that must suppress TS2320 and the synthetic
// member must not crash navigation.
const mixinMergeText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class A extends Base {
        public a!: string = ""
        override initialize(config: AConfig): void { super.initialize(config) }
    }

    @mixin()
    class B extends Base {
        public b!: number = 0
        override initialize(config: BConfig): void { super.initialize(config) }
    }

    @mixin()
    class Combined extends Base implements A, B {
        public x!: boolean = false
    }

    class Holder extends Base implements Combined {
        public h!: string = ""
    }

    const created = Holder.new({ a : "x", b : 1, x : true, h : "h" })

    // The merged config requires every contributed field; the @ts-expect-error directives
    // double as assertions in the editor too - an unused one surfaces as TS2578.

    // @ts-expect-error - 'a' (from mixin A) is required in the merged config
    const missingA = Holder.new({ b : 1, x : true, h : "h" })
    // @ts-expect-error - 'b' (from mixin B) is required in the merged config
    const missingB = Holder.new({ a : "x", x : true, h : "h" })
    // @ts-expect-error - 'x' (from mixin Combined) is required in the merged config
    const missingX = Holder.new({ a : "x", b : 1, h : "h" })
    // @ts-expect-error - 'h' (Holder's own field) is required in the merged config
    const missingH = Holder.new({ a : "x", b : 1, x : true })

    void [ created, missingA, missingB, missingX, missingH ]
`)

it("tsserver reports no merge/config errors in the editor for a construction mixin merging initialize-overriding mixins", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: mixinMergeText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                mixinMergeText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        // No TS2320 (the merge is fixed) and no TS2578 (every @ts-expect-error is used, i.e.
        // the merged config really does require each contributed field).
        t.equal(
            diagnostics.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`).join("\n"),
            "",
            "A construction mixin merging initialize-overriding mixins is clean in the editor; the merged config requires every contributed field"
        )
    } finally {
        await fixture.dispose()
    }
})

// A three-level chain where every level overrides `initialize` with its own config and the
// middle one is a construction mixin (`extends Base implements Mixin1`). Its `__Mixin2$base`
// interface extends Base + Mixin1 but - unlike the emit structural interface - never carries
// the class's own `initialize`, so it needs the protocol member injected even though Mixin2
// declares `initialize`. This is editor-only: emit is clean even without the fix, so only a
// source-view diagnostics check guards it.
const chainText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Mixin1 extends Base {
        public one!: string = ""
        override initialize(config: Mixin1Config): void { super.initialize(config) }
    }

    @mixin()
    class Mixin2 extends Base implements Mixin1 {
        public two!: number = 0
        override initialize(config: Mixin2Config): void { super.initialize(config) }
    }

    class Consumer extends Base implements Mixin2 {
        public three!: boolean = false
        override initialize(config: ConsumerConfig): void { super.initialize(config) }
    }

    const created = Consumer.new({ one : "x", two : 1, three : true })

    // The merged config requires every contributed field and rejects unknown ones; an
    // expect-error directive that does not fire surfaces as TS2578 below.

    // @ts-expect-error - 'one' (from Mixin1) is required in the merged config
    const missingOne = Consumer.new({ two : 1, three : true })
    // @ts-expect-error - 'two' (from Mixin2) is required in the merged config
    const missingTwo = Consumer.new({ one : "x", three : true })
    // @ts-expect-error - 'three' (Consumer's own field) is required in the merged config
    const missingThree = Consumer.new({ one : "x", two : 1 })
    // @ts-expect-error - 'nope' is not a known config property
    const unexpected = Consumer.new({ one : "x", two : 1, three : true, nope : 0 })

    void [ created, missingOne, missingTwo, missingThree, unexpected ]
`)

it("tsserver reports no merge/config errors in the editor for a chain where a construction mixin overrides initialize and depends on another", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: chainText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                chainText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        // No TS2320 (the chain's `__Mixin2$base` merge is fixed) and no TS2578 (every
        // expect-error directive is used, i.e. the merged config requires each field and
        // rejects unknown ones).
        t.equal(
            diagnostics.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`).join("\n"),
            "",
            "A construction mixin in a chain is clean in the editor; the merged config requires every field and rejects unknown ones"
        )
    } finally {
        await fixture.dispose()
    }
})

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

// A plain class that extends a construction mixin directly and adds a required config
// field. Not the idiomatic pattern (prefer `implements`), but supported: the mixin's `new`
// is a (bivariant) method, so the subclass's `static new(props: EventConfig)` does not clash
// (TS2417). Guards the editor view (the emit-path probe alone would not cover source view).
const extendsMixinText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Timestamped extends Base {
        public createdAt!: Date = new Date()
    }

    class Event extends Timestamped {
        public name!: string = ""
    }

    const created = Event.new({ createdAt : new Date(), name : "x" })

    // @ts-expect-error - 'name' is required in the subclass config
    const missingName = Event.new({ createdAt : new Date() })

    void [ created, missingName ]
`)

it("tsserver reports no static-side errors in the editor when a class extends a construction mixin and adds a required field", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: extendsMixinText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                extendsMixinText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        // No TS2417 (the static-side `new` stays assignable) and no TS2578 (the expect-error
        // fires, i.e. the subclass config really requires `name`).
        t.equal(
            diagnostics.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`).join("\n"),
            "",
            "Extending a construction mixin and adding a required field is clean in the editor; the subclass config requires the field"
        )
    } finally {
        await fixture.dispose()
    }
})
