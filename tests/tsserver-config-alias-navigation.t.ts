import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, openTsServerSession, positionToLineOffset } from "./tsserver-util.js"

// In source view the transform appends each generated `<Name>Config` alias as REAL text past
// the document end so its name renders natively (diagnostics / hover / quickinfo). That tail
// is LIVE for the language service, so the companion `language-service-plugin` (wired into the
// fixture tsconfig, see `createTsconfig`) must hide it from navigation:
//   - find-references returns NO span past the on-disk document (the appended `Pick<Account,…>`
//     references the class/fields — those phantom hits must be dropped);
//   - go-to-definition on the alias REMAPS onto the owning class' name (not the phantom tail,
//     and not nothing).

const text = trimIndent(`
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

const lineCount = text.split("\n").length

type RefBody = { refs?: Array<{ file: string, start: { line: number, offset: number } }> }
type DefBody = Array<{ file: string, start: { line: number, offset: number } }>

it("editor names the config alias natively and the ls-plugin keeps its appended text out of navigation", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const session    = openTsServerSession(fixture.directory)

        await session.open(sourceFile, text)

        // The failing `.new(...)` diagnostic names the alias NATIVELY (real appended text).
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t, await session.request("semanticDiagnosticsSync", { file: sourceFile }))
        const diagText    = diagnostics.map((d) => d.text ?? "").join("\n")

        t.match(diagText, "AccountConfig", "diagnostic names the alias natively")
        t.notMatch(diagText, "parameter of type '}'", "no meaningless `}` config type")

        // find-references on the class name returns NO phantom span past the on-disk document.
        const accountPosition = text.indexOf("class Account") + "class ".length + 1
        const references      = assertResponseBody<RefBody>(
            t, await session.request("references", { file: sourceFile, ...positionToLineOffset(text, accountPosition) }))
        const referenceLines  = (references.refs ?? []).map((reference) => reference.start.line)

        t.ne(referenceLines.length, 0, "references are found")
        t.true(referenceLines.every((line) => line <= lineCount),
            `no reference past the on-disk document (lineCount=${lineCount}, got ${JSON.stringify(referenceLines)})`)

        // go-to-definition on the alias reference REMAPS onto the owning class' name.
        const aliasUse   = text.indexOf("config?: AccountConfig") + "config?: ".length + 1
        const definition = assertResponseBody<DefBody>(
            t, await session.request("definition", { file: sourceFile, ...positionToLineOffset(text, aliasUse) }))
        const classLine  = positionToLineOffset(text, text.indexOf("class Account")).line

        t.eq(definition.map((entry) => entry.start.line), [ classLine ],
            "go-to-definition on the alias lands on the owning class, not the appended tail")

        await session.close()
    } finally {
        await fixture.dispose()
    }
})
