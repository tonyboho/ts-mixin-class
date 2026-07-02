import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { openTsServerSession, positionToLineOffset } from "./tsserver-util.js"

// Completions are the everyday editor surface with the widest reach into the source-view tree:
// identifier completions read every declaration in scope — including the generated siblings
// (`__X$base`, `__X$empty`, the `__X$mixin` factory) the transform splices in. Those are real,
// bound declarations, so without filtering they leak into the list as phantom entries. The
// `language-service-plugin` companion drops them (same policy as its navigation-span filtering
// of the appended config-alias tail). Member completions (`this.`, the `.new({ … })` config
// object) resolve through the checker and must offer the mixin/config members.

type CompletionEntry = { name: string, kind?: string }
type CompletionBody = { entries?: CompletionEntry[], isMemberCompletion?: boolean }

const phantomNames = (names: string[]): string[] =>
    names.filter((name) => /^__.*\$(base|empty|mixin)/.test(name))

async function completionsAt(
    t: Test,
    text: string,
    marker: string,
    offsetInMarker: number
): Promise<{ names: string[], isMemberCompletion: boolean | undefined }> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })
    const session = openTsServerSession(fixture.directory)

    try {
        const file = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        await session.open(file, text)

        const markerIndex = text.indexOf(marker)

        t.true(markerIndex >= 0, `marker found: ${marker}`)

        const { line, offset } = positionToLineOffset(text, markerIndex + offsetInMarker)
        const response         = await session.request("completionInfo", { file, line, offset })

        t.is(response.success, true, `completionInfo answers (did not crash): ${(response.message ?? "").split("\n")[0]}`)

        const body = response.body as CompletionBody | undefined

        return {
            names              : (body?.entries ?? []).map((entry) => entry.name),
            isMemberCompletion : body?.isMemberCompletion
        }
    } finally {
        await session.close()
        await fixture.dispose()
    }
}

const consumerText = trimIndent(`
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

    void Widget
`)

it("`this.` inside a consumer method completes the mixin's members", async (t: Test) => {
    const { names } = await completionsAt(t, consumerText, "return this.describe()", "return this.".length)

    t.true(names.includes("describe"), "the mixin's method is offered")
    t.true(names.includes("label"), "the mixin's field is offered")
    t.true(names.includes("own"), "the consumer's own method is offered")
    t.eq(phantomNames(names), [], "no generated phantom names leak into member completions")
})

it("the `.new({ … })` config object completes the config keys as a member completion", async (t: Test) => {
    const { names, isMemberCompletion } = await completionsAt(t, consumerText, 'Panel.new({ label: "x" })', "Panel.new({ ".length)

    t.true(names.includes("label"), "the config key is offered")
    t.is(isMemberCompletion, true, "the list is a member (property) completion, not a scope-identifier dump")
    t.eq(phantomNames(names), [], "no generated phantom names leak into the config completion")
})

it("module-scope identifier completions do not leak generated phantom names", async (t: Test) => {
    // An expression position at top level (`void Widget`): identifier completions here read the
    // whole module scope — exactly where the generated top-level siblings live.
    const { names } = await completionsAt(t, consumerText, "void Widget", "void W".length)

    t.true(names.includes("Widget"), "the real mixin class is offered")
    t.true(names.includes("Panel"), "the real consumer class is offered")
    t.eq(phantomNames(names), [], "no generated phantom names leak into module-scope completions")
})

it("identifier completions inside a nested-scope function do not leak generated phantom names", async (t: Test) => {
    // A nested mixin/consumer splices generated siblings into the FUNCTION body — local-scope
    // identifier completions must not offer them.
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        export function build(): string {
            @mixin()
            class LocalMixin {
                greet(): string {
                    return "hi"
                }
            }

            class LocalUser implements LocalMixin {
            }

            const made = new LocalUser().greet()

            return made
        }
    `)

    const { names } = await completionsAt(t, text, "return made", "return made".length)

    t.true(names.includes("made"), "the local variable is offered")
    t.true(names.includes("LocalUser"), "the local consumer class is offered")
    t.true(names.includes("LocalMixin"), "the local mixin class is offered")
    t.eq(phantomNames(names), [], "no generated phantom names leak into the nested scope completions")
})
