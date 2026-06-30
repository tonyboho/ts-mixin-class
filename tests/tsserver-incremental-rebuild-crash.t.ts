import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { openTsServerSession, positionToLineOffset } from "./tsserver-util.js"

// Regression guard: an editor edit (open -> change -> re-request diagnostics) must not crash
// tsserver under `moduleResolution: NodeNext`.
//
// Root cause (was a 100%-on-every-keystroke crash in the real `ts-serializable` package): the
// source-view transform clones the source file (`cloneSourceFileForTransform`, used when a file
// declares a nested-scope mixin/consumer) and reprints it WITHOUT carrying over the original
// file's `impliedNodeFormat`. Under NodeNext that field is part of the `DocumentRegistry` bucket
// key, so the file is acquired under key `...|<format>` but the cloned/reprinted file is released
// under key `...` (no mode) on the next incremental program build -> the bucket is missing ->
// `Debug.checkDefined` throws `Debug Failure` inside `releaseDocumentWithKey` -> the diagnostics
// request aborts and the editor silently shows NOTHING.
//
// Why the rest of the tsserver suite never caught it: `createTypeScriptFixture` defaults to
// `moduleResolution: Bundler`, where `impliedNodeFormat` is always undefined, so the acquire and
// release keys trivially match. This test pins `NodeNext` plus a nested consumer (the clone path)
// plus the open -> edit -> re-request cycle (the second, incremental program build) -- the exact
// combination that desynced the registry. It crashed deterministically before the fix.

const text = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    export class Widget extends Base {
        label(): string {
            return "w"
        }
    }

    function make(): void {
        class Local extends Base implements Widget {}
        void Local
    }

    void make
`)

it("an editor edit under NodeNext does not crash tsserver on the incremental rebuild", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { module: "NodeNext", moduleResolution: "NodeNext" },
        sourceFiles            : [ { fileName: "only.ts", text } ]
    })

    const session = openTsServerSession(fixture.directory)

    try {
        const file = requiredFixtureSourceFile(fixture.sourceFiles, "only.ts")

        await session.open(file, text)

        const before = await session.request("syntacticDiagnosticsSync", { file })
        t.is(before.success, true, "the first diagnostics request succeeds")

        // One keystroke: append a comment at EOF, exactly as the editor would, forcing the
        // incremental program rebuild that releases the previously-acquired source file.
        const eof = positionToLineOffset(text, text.length)
        await session.request("change", {
            file,
            line         : eof.line,
            offset       : eof.offset,
            endLine      : eof.line,
            endOffset    : eof.offset,
            insertString : "\n// edit\n"
        })

        const after = await session.request("syntacticDiagnosticsSync", { file })

        t.is(
            after.success,
            true,
            `the diagnostics request after an edit must not crash tsserver: ${(after.message ?? "").split("\n")[0]}`
        )
    } finally {
        await session.close()
        await fixture.dispose()
    }
})
