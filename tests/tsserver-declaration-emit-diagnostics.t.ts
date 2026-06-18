import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, runTypeScriptServerRequest } from "./tsserver-util.js"

type SemanticDiagnostic = { code?: number, text?: string, message?: string }

// Regression guard: under `declaration: true`, requesting semantic diagnostics for a
// file with a valid `@mixin` class used to crash tsserver server-side, so the editor
// received an error response and showed **no diagnostics at all** — real type errors
// silently disappeared in the IDE while `tsc` still reported them. (Found via the
// ts-serializable package, whose tsconfig has `declaration: true`.)
//
// Cause: semantic diagnostics also compute declaration diagnostics when `declaration`
// is enabled, running TypeScript's declaration-emit transform over the source-view
// tree. It crashed in `isDeclarationAndNotVisible` (`getParseTreeNode(node).kind` on
// `undefined`) on a fully-synthetic generated member — the construction `static new`,
// which carries no `.original`. `alignGeneratedNavigableNodesWithParseTree` now clears
// the `Synthesized` flag on such generated members so they resolve to themselves.
//
// The fixture below both triggers declaration emit (a mixin) and contains a deliberate
// type error, so the test guards two things at once: the request no longer crashes,
// and real semantic errors still surface through it.
const mixinUnderDeclarationEmitText = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    export class Widget extends Base {
        value: number = 0
    }

    export const widget = Widget.new()

    // Deliberate type error that must surface through semantic diagnostics.
    export const broken: string = widget.value
`)

it("tsserver semantic diagnostics succeed and surface errors on a mixin under declaration emit", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { declaration : true },
        sourceFiles            : [ { fileName : "source.ts", text : mixinUnderDeclarationEmitText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const response    = await runTypeScriptServerRequest(
            fixture.directory,
            sourceFile,
            mixinUnderDeclarationEmitText,
            "semanticDiagnosticsSync",
            { file : sourceFile }
        )
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(t, response)
        const codes       = diagnostics.map((diagnostic) => diagnostic.code)

        t.true(
            codes.includes(2322),
            `Semantic diagnostics should report the deliberate type error (TS2322); got codes [${codes.join(", ")}]`
        )
    } finally {
        await fixture.dispose()
    }
})
