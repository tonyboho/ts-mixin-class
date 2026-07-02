import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { openTsServerSession, positionToLineOffset } from "./tsserver-util.js"

// The remaining everyday editor services over the source-view tree: signature help, the
// navigation tree (outline), and outlining (folding) spans. All three walk the transformed AST
// through tsserver's services layer — the same crash surface as quickinfo/navigation — and the
// outline additionally must not display the generated helper declarations.

const text = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    export class Widget extends Base {
        public label!: string

        describe(): string {
            return this.label
        }
    }

    export class Panel extends Base implements Widget {
        own(): string {
            return this.describe()
        }
    }

    export const panel = Panel.new({ label: "x" })

    export function build(): string {
        @mixin()
        class LocalMixin {
            greet(): string {
                return "hi"
            }
        }

        class LocalUser implements LocalMixin {
        }

        return new LocalUser().greet()
    }
`)

type SignatureHelpBody = {
    items? : Array<{ parameters?: Array<{ name?: string, displayParts?: Array<{ text: string }> }> }>
}
type NavTreeNode = { text?: string, childItems?: NavTreeNode[] }
type OutliningSpan = { textSpan?: { start: unknown } }

function collectNavTreeTexts(node: NavTreeNode | undefined, out: string[] = []): string[] {
    if (node === undefined) {
        return out
    }

    if (node.text !== undefined) {
        out.push(node.text)
    }

    for (const child of node.childItems ?? []) {
        collectNavTreeTexts(child, out)
    }

    return out
}

it("signature help, navtree and outlining spans work over the transformed source view", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })
    const session = openTsServerSession(fixture.directory)

    try {
        const file = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        await session.open(file, text)

        // --- signature help on the generated `.new(` ---
        const callPosition     = text.indexOf('Panel.new({ label: "x" })') + "Panel.new(".length
        const { line, offset } = positionToLineOffset(text, callPosition)
        const signatureHelp    = await session.request("signatureHelp", { file, line, offset })

        t.is(signatureHelp.success, true, `signatureHelp answers: ${(signatureHelp.message ?? "").split("\n")[0]}`)

        const items      = (signatureHelp.body as SignatureHelpBody | undefined)?.items ?? []
        const firstParam = items[0]?.parameters?.[0]
        const paramText  = (firstParam?.displayParts ?? []).map((part) => part.text).join("")

        t.true(items.length > 0, "the generated static .new offers at least one signature")
        t.match(paramText, "PanelConfig", "the signature names the generated <Name>Config alias for the props parameter")

        // --- navigation tree (outline) ---
        const navtree = await session.request("navtree", { file })

        t.is(navtree.success, true, `navtree answers: ${(navtree.message ?? "").split("\n")[0]}`)

        const texts    = collectNavTreeTexts(navtree.body as NavTreeNode | undefined)
        const phantoms = texts.filter((name) => /^__.*\$(base|empty|mixin)/.test(name) || /Config$/.test(name))

        t.true(texts.includes("Widget"), "the outline lists the mixin class")
        t.true(texts.includes("Panel"), "the outline lists the consumer class")
        t.true(texts.includes("build"), "the outline lists the function with nested declarations")
        t.eq(phantoms, [], "the outline shows no generated helper or appended-alias entries")

        // --- outlining (folding) spans ---
        const outlining = await session.request("getOutliningSpans", { file })

        t.is(outlining.success, true, `getOutliningSpans answers: ${(outlining.message ?? "").split("\n")[0]}`)

        const spans = (outlining.body as OutliningSpan[] | undefined) ?? []

        t.true(spans.length > 0, "folding spans are produced for the transformed file")
    } finally {
        await session.close()
        await fixture.dispose()
    }
})
