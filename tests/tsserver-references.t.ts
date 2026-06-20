import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
import {
    consumerSuperMixinMethodArgs,
    consumerSuperMixinPropertyArgs,
    createEditorFixture,
    request,
    selfMixinMethodArgs,
    selfMixinPropertyArgs,
    selfMixinStaticPropertyArgs,
    sourceSlice,
    sourceText,
    superMixinMethodArgs,
    superMixinPropertyArgs,
    usageArgs
} from "./tsserver-editor-util.js"
import type { DefinitionInfo, QuickInfoBody, TextSpan } from "./tsserver-editor-util.js"

type ReferencesBody = {
    refs? : Array<TextSpan & {
        file          : string,
        isDefinition? : boolean
    }>
}

it("tsserver references resolve mixin properties from self, external and super usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args: selfMixinPropertyArgs(sourceFile), description: "self mixin property usage" },
            { args: usageArgs(sourceFile, "mixinProperty"), description: "external mixin property usage" },
            { args: superMixinPropertyArgs(sourceFile), description: "mixin super property usage" },
            { args: consumerSuperMixinPropertyArgs(sourceFile), description: "consumer super property usage" }
        ]) {
            const body = assertResponseBody<ReferencesBody>(
                t,
                await request(sourceFile, "references", scenario.args)
            )
            const refs = body.refs ?? []

            t.expect(uniqueLocalSpanTexts(sourceFile, refs)).toEqual([ "mixinProperty" ])
            t.equal(countLocalSpans(sourceFile, refs, "mixinProperty"), 5, `References include declaration and all source usages from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver references resolve plain class members from instance and static usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args: usageArgs(sourceFile, "baseProperty"), count: 3, memberName: "baseProperty", description: "plain base property usage" },
            { args: usageArgs(sourceFile, "baseMethod"), count: 2, memberName: "baseMethod", description: "plain base method usage" },
            { args: usageArgs(sourceFile, "baseStaticProperty"), count: 3, memberName: "baseStaticProperty", description: "plain base static property usage" },
            { args: usageArgs(sourceFile, "baseStaticMethod"), count: 2, memberName: "baseStaticMethod", description: "plain base static method usage" }
        ]) {
            const body = assertResponseBody<ReferencesBody>(
                t,
                await request(sourceFile, "references", scenario.args)
            )
            const refs = body.refs ?? []

            t.expect(uniqueLocalSpanTexts(sourceFile, refs)).toEqual([ scenario.memberName ])
            t.equal(countLocalSpans(sourceFile, refs, scenario.memberName), scenario.count, `References include declaration and all source usages from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver references resolve mixin methods from self, external and super usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args: selfMixinMethodArgs(sourceFile), description: "self mixin method call" },
            { args: usageArgs(sourceFile, "mixinMethod"), description: "external mixin method call" },
            { args: superMixinMethodArgs(sourceFile), description: "mixin super method call" },
            { args: consumerSuperMixinMethodArgs(sourceFile), description: "consumer super method call" }
        ]) {
            const body = assertResponseBody<ReferencesBody>(
                t,
                await request(sourceFile, "references", scenario.args)
            )
            const refs = body.refs ?? []

            t.expect(uniqueLocalSpanTexts(sourceFile, refs)).toEqual([ "mixinMethod" ])
            t.equal(countLocalSpans(sourceFile, refs, "mixinMethod"), 5, `References include declaration and all source usages from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver references resolve mixin static members from self and external usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args: selfMixinStaticPropertyArgs(sourceFile), count: 3, memberName: "mixinStaticProperty", description: "self mixin static property usage" },
            { args: usageArgs(sourceFile, "mixinStaticProperty"), count: 3, memberName: "mixinStaticProperty", description: "external mixin static property usage" },
            { args: usageArgs(sourceFile, "mixinStaticMethod"), count: 2, memberName: "mixinStaticMethod", description: "external mixin static method usage" }
        ]) {
            const body = assertResponseBody<ReferencesBody>(
                t,
                await request(sourceFile, "references", scenario.args)
            )
            const refs = body.refs ?? []

            t.expect(uniqueLocalSpanTexts(sourceFile, refs)).toEqual([ scenario.memberName ])
            t.equal(countLocalSpans(sourceFile, refs, scenario.memberName), scenario.count, `References include declaration and all source usages from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

const consumerClassNameText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Tagged<T> {
        tag?: T
    }

    class Crate<T> implements Tagged<T> {
        contents?: T
    }

    const crate = new Crate<number>()
    void crate
`)

it("tsserver navigation on a consumer class name reaches its own declaration", async (t: Test) => {
    // Regression: the generated `Crate$base` interface and class were range-mapped
    // onto the consumer's header, so they overlapped the original `Crate` name.
    // getTokenAtPosition then resolved a click on the class name to a `$base` node,
    // so find-all-references and go-to-definition on the consumer name missed the
    // declaration itself — clicking the class name in the editor did nothing. The
    // `$base` helpers are now collapsed off-screen, so the real declaration owns the
    // position again.
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: consumerClassNameText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const declOffset  = positionToLineOffset(consumerClassNameText, consumerClassNameText.indexOf("Crate<T> implements"))
        const usageOffset = positionToLineOffset(consumerClassNameText, consumerClassNameText.indexOf("Crate<number>"))

        const references = assertResponseBody<ReferencesBody>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, consumerClassNameText, "references", {
                file : sourceFile,
                ...declOffset
            })
        ).refs ?? []

        t.true(
            references.some((ref) =>
                ref.file === sourceFile && ref.start.line === declOffset.line && ref.start.offset === declOffset.offset),
            "Find-all-references from the consumer class name includes its own declaration"
        )
        t.true(
            references.some((ref) => ref.isDefinition === true),
            "Find-all-references marks the consumer declaration occurrence as a definition"
        )

        const definitions = assertResponseBody<DefinitionInfo[]>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, consumerClassNameText, "definition", {
                file : sourceFile,
                ...usageOffset
            })
        )

        t.true(
            definitions.some((definition) =>
                definition.file === sourceFile &&
                definition.start.line === declOffset.line &&
                definition.start.offset === declOffset.offset),
            "Go-to-definition from `new Crate<number>()` lands on the consumer class declaration"
        )
    } finally {
        await fixture.dispose()
    }
})

const consumerExtendsLocalBaseText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class LocalBase {
        baseValue: number = 0
    }

    @mixin()
    class Feature {
        feature?: string
    }

    class Widget extends LocalBase implements Feature {
        widget?: boolean
    }
`)

it("tsserver navigation on a base type in an extends clause reaches the base class", async (t: Test) => {
    // The base type name in a consumer's `extends LocalBase` navigates to the real
    // `class LocalBase`, like it would without the transform.
    //
    // This used to be a KNOWN GAP: source view rewrote `extends LocalBase` to
    // `extends Widget$base` and pinned the generated `$base` reference onto the
    // source `LocalBase` position, so the base name resolved to the internal
    // `$base`. It is now fixed for a well-typed NON-GENERIC, non-construction
    // consumer: the navigable-base fast path re-extends the real base under a
    // single-source cast (`extends (LocalBase as unknown as <cast>)`), keeping the
    // real `LocalBase` identifier on its source position. Generic and
    // construction-base consumers still go through `$base` (see AGENTS.md invariant
    // #9 "Known gap"), so navigation on their base name remains unresolved.
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: consumerExtendsLocalBaseText } ]
    })

    try {
        const sourceFile    = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const declOffset    = positionToLineOffset(consumerExtendsLocalBaseText, consumerExtendsLocalBaseText.indexOf("class LocalBase") + "class ".length)
        const extendsOffset = positionToLineOffset(consumerExtendsLocalBaseText, consumerExtendsLocalBaseText.indexOf("extends LocalBase") + "extends ".length)

        const landsOnDeclaration = (span: { file?: string, start: { line: number, offset: number } }): boolean =>
            (span.file === undefined || span.file === sourceFile) &&
            span.start.line === declOffset.line &&
            span.start.offset === declOffset.offset

        const definitions = assertResponseBody<DefinitionInfo[]>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, consumerExtendsLocalBaseText, "definition", {
                file : sourceFile,
                ...extendsOffset
            })
        )

        const references = assertResponseBody<ReferencesBody>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, consumerExtendsLocalBaseText, "references", {
                file : sourceFile,
                ...extendsOffset
            })
        ).refs ?? []

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, consumerExtendsLocalBaseText, "quickinfo", {
                file : sourceFile,
                ...extendsOffset
            })
        )

        t.true(definitions.some(landsOnDeclaration),
            "Go-to-definition on the base name in `extends LocalBase` lands on `class LocalBase`")

        t.true(references.some(landsOnDeclaration),
            "Find-all-references from the base name in `extends LocalBase` includes the `class LocalBase` declaration")

        t.equal(quickInfo.displayString, "class LocalBase",
            "Quickinfo on the base name in `extends LocalBase` reports the base class, not the internal `$base`")
    } finally {
        await fixture.dispose()
    }
})

function uniqueLocalSpanTexts(sourceFile: string, spans: Array<TextSpan & { file?: string }>): string[] {
    return [ ...new Set(spans
        .filter((span) => span.file === undefined || span.file === sourceFile)
        .map((span) => sourceSlice(sourceText, span))
    ) ].sort()
}

function countLocalSpans(sourceFile: string, spans: Array<TextSpan & { file?: string }>, text: string): number {
    const keys = new Set(spans
        .filter((span) => span.file === undefined || span.file === sourceFile)
        .filter((span) => sourceSlice(sourceText, span) === text)
        .map((span) => `${span.start.line}:${span.start.offset}:${span.end.line}:${span.end.offset}`)
    )

    return keys.size
}

// Navigable-base fast path (non-generic consumer): go-to-definition + quickinfo on
// the base name in `extends <Base>` reach the real base class. Variants beyond the
// plain-local case: a concrete-generic base, a qualified base, and a cross-file base.
async function assertBaseNameNavigates(t: Test, options: {
    sourceFiles       : Array<{ fileName: string, text: string }>,
    targetFileName    : string,
    targetText        : string,
    baseNameIndex     : number,
    baseDeclFileName  : string,
    baseDeclText      : string,
    baseDeclNameIndex : number,
    displayString     : string
}): Promise<void> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : options.sourceFiles
    })

    try {
        const targetFile = requiredFixtureSourceFile(fixture.sourceFiles, options.targetFileName)
        const declFile   = requiredFixtureSourceFile(fixture.sourceFiles, options.baseDeclFileName)
        const baseOffset = positionToLineOffset(options.targetText, options.baseNameIndex)
        const declPos    = positionToLineOffset(options.baseDeclText, options.baseDeclNameIndex)

        const definitions = assertResponseBody<DefinitionInfo[]>(
            t,
            await runTypeScriptServerRequest(fixture.directory, targetFile, options.targetText, "definition", {
                file : targetFile,
                ...baseOffset
            })
        )

        t.true(definitions.some((definition) =>
            (definition.file === undefined || definition.file === declFile) &&
            definition.start.line === declPos.line &&
            definition.start.offset === declPos.offset),
        `Go-to-definition on the base name lands on its declaration\n${JSON.stringify(definitions)}`)

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(fixture.directory, targetFile, options.targetText, "quickinfo", {
                file : targetFile,
                ...baseOffset
            })
        )

        t.match(quickInfo.displayString ?? "", options.displayString,
            `Quickinfo on the base name reports the real base class\n${quickInfo.displayString}`)
    } finally {
        await fixture.dispose()
    }
}

it("tsserver navigation on a concrete-generic base name (`extends Holder<string>`) reaches the base class", async (t: Test) => {
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        class Holder<T> {
            value!: T
        }

        @mixin()
        class Feature {
            feature?: string
        }

        class Widget extends Holder<string> implements Feature {
            widget?: boolean
        }
    `)

    await assertBaseNameNavigates(t, {
        sourceFiles       : [ { fileName: "source.ts", text } ],
        targetFileName    : "source.ts",
        targetText        : text,
        baseNameIndex     : text.indexOf("extends Holder<string>") + "extends ".length,
        baseDeclFileName  : "source.ts",
        baseDeclText      : text,
        baseDeclNameIndex : text.indexOf("class Holder") + "class ".length,
        displayString     : "class Holder<T>"
    })
})

it("tsserver keeps a qualified-base consumer (`extends shapes.Base`) type-checking via $base", async (t: Test) => {
    // A qualified base is excluded from the navigable-base fast path (a shallow clone
    // leaves the inner `Base` at `[-1, -1]`, so the base name is not navigable), so it
    // keeps the `$base` rewrite — navigation on the base name is the residual gap. This
    // guards that the `$base` path still handles a qualified base with NO regression:
    // the consumer compiles clean and its OWN members stay navigable.
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        namespace shapes {
            export class Base {
                baseValue: number = 0
            }
        }

        @mixin()
        class Feature {
            feature?: string
        }

        class Widget extends shapes.Base implements Feature {
            widget?: boolean
        }

        const widget = new Widget()
        const value: number = widget.baseValue
        void value
    `)

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ text?: string }>>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, text, "semanticDiagnosticsSync", {
                file : sourceFile
            })
        )

        t.equal(diagnostics.map((diagnostic) => diagnostic.text ?? "").join("\n"), "",
            "A qualified-base consumer compiles with no IDE diagnostics through the $base path")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver navigation on a cross-file base name (`extends RemoteBase`) reaches the base class", async (t: Test) => {
    const baseText = trimIndent(`
        export class RemoteBase {
            baseValue: number = 0
        }
    `)
    const text     = trimIndent(`
        import { RemoteBase } from "./base.js"
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Feature {
            feature?: string
        }

        class Widget extends RemoteBase implements Feature {
            widget?: boolean
        }
    `)

    await assertBaseNameNavigates(t, {
        sourceFiles       : [ { fileName: "base.ts", text: baseText }, { fileName: "source.ts", text } ],
        targetFileName    : "source.ts",
        targetText        : text,
        baseNameIndex     : text.indexOf("extends RemoteBase") + "extends ".length,
        baseDeclFileName  : "base.ts",
        baseDeclText      : baseText,
        baseDeclNameIndex : baseText.indexOf("class RemoteBase") + "class ".length,
        displayString     : "class RemoteBase"
    })
})
