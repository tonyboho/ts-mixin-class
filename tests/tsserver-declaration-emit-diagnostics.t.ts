import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { runTypeScriptServerRequest } from "./tsserver-util.js"

// Repro for a tsserver crash: under `declaration: true`, requesting semantic
// diagnostics for a file with a *valid* `@mixin` class throws server-side, so the
// editor receives an error response and shows **no diagnostics at all** — real type
// errors in the file silently disappear in the IDE while `tsc` still reports them.
// (Found via the ts-serializable package, whose tsconfig has `declaration: true`;
// minimised here to a single mixin class. Decorator mode is irrelevant — both
// legacy and standard decorators crash.)
//
// Why this was not caught: the crash needs the intersection of three things — a
// VALID mixin (which generates the navigable `$base` interface/class helpers),
// `declaration: true` (so semantic diagnostics also run declaration-emit
// diagnostics), and the tsserver/source-view path (generated nodes whose parse-tree
// mapping does not resolve). The `declaration-fixture-suite` exercises valid mixins
// under `declaration: true` but via batch `tsc` (the emit path, over reprinted +
// reparsed source) — it never hits this path. The `tsserver-diagnostics.t.ts` tests
// run under `declaration: true` via tsserver, but on INVALID mixins, which the
// transform rejects with a custom diagnostic before generating any `$base` helpers,
// so declaration emit has no generated node to crash on. This is the first test to
// hit all three at once.
//
// TODO(declaration-emit diagnostics crash): KNOWN GAP. tsserver's
// `semanticDiagnosticsSync` also computes declaration diagnostics when
// `declaration` is enabled. That runs TypeScript's declaration-emit transform over
// the source-view tree, which crashes in `isDeclarationAndNotVisible`
// (`getParseTreeNode(node).kind` on `undefined`) on a generated declaration node
// whose parse-tree mapping does not resolve — the same family as invariant #9, but
// reached through the declaration-emit path rather than navigation. Batch `tsc`
// reports the file's real errors; only the tsserver/source-view path crashes, and
// quickinfo/completions keep working (different code path), which is why the IDE
// looks merely "error-free". Workaround: `declaration: false`. The assertion below
// states the correct behaviour (the request succeeds) and is wrapped in `t.todo` so
// it runs and stays visible without failing the suite. See TODO.md.
const mixinUnderDeclarationEmitText = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    export class Widget extends Base {
        value: number = 0
    }

    export const widget = Widget.new()
`)

it("tsserver semantic diagnostics succeed on a mixin under declaration emit", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { declaration : true },
        sourceFiles            : [ { fileName : "source.ts", text : mixinUnderDeclarationEmitText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const response   = await runTypeScriptServerRequest(
            fixture.directory,
            sourceFile,
            mixinUnderDeclarationEmitText,
            "semanticDiagnosticsSync",
            { file : sourceFile }
        )

        t.todo("semanticDiagnosticsSync does not crash under `declaration: true` (declaration-emit gap)", (t: Test) => {
            t.true(
                response.success,
                `semanticDiagnosticsSync should succeed; instead the server returned: ${response.message ?? "<no message>"}`
            )
        })
    } finally {
        await fixture.dispose()
    }
})
