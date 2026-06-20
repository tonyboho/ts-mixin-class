import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"

// Regression guard for commit 1a0c13e: source-view go-to-definition / rename /
// quickinfo used to crash the checker with "Cannot read properties of undefined
// (reading 'members')" for a whole class of navigable symbols.
//
// The source-view source file is built from a throwaway clone the program never
// binds; generated class-likes, identifiers, type parameters, type references,
// heritage expressions and constructors keep `.original` links into that unbound
// clone. tsserver navigation walks `.original` via getParseTreeNode (whose
// isParseTreeNode test consults only the `Synthesized` flag) into the clone, and
// forEachSymbolTableInScope then reads `.members` of the unbound class and
// crashes. The fix clears the `Synthesized` flag on those generated nodes
// (keeping `.original`) so navigation stops at the bound node.
//
// `assertResponseBody` asserts `response.success`, so a re-introduced crash
// surfaces here as a failed navigation request. The whole-suite probabilistic
// guard is `stress-rename` / `stress-quickinfo`; these pin the most common crash
// sites deterministically (type parameters were the largest group; the
// implements-only consumer constructor was the trickiest). Each scenario below
// was confirmed to crash with the fix disabled.

type Args = { file: string, line: number, offset: number }
type DefinitionBody = Array<{ file: string }>
type QuickInfoBody = { displayString?: string }
type RenameBody = { info?: { canRename?: boolean, displayName?: string } }

function at(file: string, text: string, marker: string, withinMarker = 0): Args {
    const markerIndex = text.indexOf(marker)

    if (markerIndex < 0) {
        throw new Error(`Cannot find marker: ${marker}`)
    }

    return { file, ...positionToLineOffset(text, markerIndex + withinMarker) }
}

// Opens a fresh server, fires one request, asserts the server answered (did not
// crash) and returns the body for further checks. `files[0]` is the file the
// request targets.
async function navigate<Body>(
    t: Test,
    files: Array<{ fileName: string, text: string }>,
    command: string,
    targetMarker: { fileName: string, text: string, marker: string, withinMarker?: number }
): Promise<Body> {
    const fixture = await createTypeScriptFixture({ experimentalDecorators: false, sourceFiles: files })

    try {
        const targetFile = requiredFixtureSourceFile(fixture.sourceFiles, targetMarker.fileName)
        const args       = at(targetFile, targetMarker.text, targetMarker.marker, targetMarker.withinMarker)

        return assertResponseBody<Body>(
            t,
            await runTypeScriptServerRequest(fixture.directory, targetFile, targetMarker.text, command, args)
        )
    } finally {
        await fixture.dispose()
    }
}

const genericMixinText = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    class Container<T> extends Base {
        item?: T

        read(): T | undefined {
            return this.item
        }
    }
`)

it("tsserver navigation does not crash on a generic mixin's type parameter", async (t: Test) => {
    // Crash site: navigating a type parameter ran forEachSymbolTableInScope from
    // the generated (unbound-clone) class and read `.members` of undefined.
    const files = [ { fileName: "source.ts", text: genericMixinText } ]
    const usage = { fileName: "source.ts", text: genericMixinText, marker: "item?: T", withinMarker: "item?: ".length }

    const quickInfo = await navigate<QuickInfoBody>(t, files, "quickinfo", usage)
    t.match(quickInfo.displayString ?? "", "(type parameter) T", "Quickinfo on the type parameter resolves instead of crashing")

    const definitions = await navigate<DefinitionBody>(t, files, "definition", usage)
    t.true(definitions.length > 0, "Go-to-definition on the type parameter resolves instead of crashing")

    const rename = await navigate<RenameBody>(t, files, "rename", { fileName: "source.ts", text: genericMixinText, marker: "<T>", withinMarker: 1 })
    t.true(rename.info?.canRename, "Rename on the type parameter responds instead of crashing")
    t.equal(rename.info?.displayName, "T", "Rename targets the type parameter")
})

const genericMixinsText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class A<X> {
        shared?: X
    }

    @mixin()
    export class B<Y> {
        marker?: Y
    }
`)

const decoratedConsumerText = trimIndent(`
    import { A, B } from "./mixins.js"

    class Root<R> {
        rootValue?: R
    }

    @mixin()
    class Combined<T> extends Root<T> implements A<T>, B<string> {
        own(): void {
            void super.shared
        }
    }
`)

it("tsserver navigation does not crash on a generic consumer's type parameter across files", async (t: Test) => {
    // Crash site: the same `.members` crash for a decorated consumer that extends a
    // generic base and implements two imported generic mixins — the shape closest
    // to the real declaration fixtures. The generated consumer heritage and its
    // type parameter both kept `.original` links into the unbound clone.
    const files = [
        { fileName: "source.ts", text: decoratedConsumerText },
        { fileName: "mixins.ts", text: genericMixinsText }
    ]

    const quickInfo = await navigate<QuickInfoBody>(t, files, "quickinfo", {
        fileName     : "source.ts",
        text         : decoratedConsumerText,
        marker       : "Combined<T>",
        withinMarker : "Combined<".length
    })

    t.match(quickInfo.displayString ?? "", "(type parameter) T", "Quickinfo on the consumer type parameter resolves instead of crashing")
})

const genericConstructionText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Boxed<T> {
        value?: T
    }

    class Box<T> implements Boxed<T> {
        constructor(public initial: T) {}
    }

    const box = new Box<number>(42)
    void box
`)

it("tsserver navigation does not crash on `new Box<…>()` of an implements-only consumer", async (t: Test) => {
    // Crash site: addSyntheticSuperCallToConstructors rebuilt the consumer
    // constructor as a synthetic node whose `.original` pointed at the clone
    // constructor; createDefinitionFromSignatureDeclaration → symbolToString →
    // forEachSymbolTableInScope walked into the detached clone class and crashed.
    const definitions = await navigate<DefinitionBody>(
        t,
        [ { fileName: "source.ts", text: genericConstructionText } ],
        "definition",
        { fileName: "source.ts", text: genericConstructionText, marker: "new Box<number>", withinMarker: "new ".length }
    )

    t.true(definitions.length > 0, "Go-to-definition on `new Box<number>()` resolves instead of crashing")
})
