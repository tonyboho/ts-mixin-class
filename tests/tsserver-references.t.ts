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
        file : string,
        isDefinition? : boolean
    }>
}

it("tsserver references resolve mixin properties from self, external and super usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinPropertyArgs(sourceFile), description : "self mixin property usage" },
            { args : usageArgs(sourceFile, "mixinProperty"), description : "external mixin property usage" },
            { args : superMixinPropertyArgs(sourceFile), description : "mixin super property usage" },
            { args : consumerSuperMixinPropertyArgs(sourceFile), description : "consumer super property usage" }
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
            { args : usageArgs(sourceFile, "baseProperty"), count : 3, memberName : "baseProperty", description : "plain base property usage" },
            { args : usageArgs(sourceFile, "baseMethod"), count : 2, memberName : "baseMethod", description : "plain base method usage" },
            { args : usageArgs(sourceFile, "baseStaticProperty"), count : 3, memberName : "baseStaticProperty", description : "plain base static property usage" },
            { args : usageArgs(sourceFile, "baseStaticMethod"), count : 2, memberName : "baseStaticMethod", description : "plain base static method usage" }
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
            { args : selfMixinMethodArgs(sourceFile), description : "self mixin method call" },
            { args : usageArgs(sourceFile, "mixinMethod"), description : "external mixin method call" },
            { args : superMixinMethodArgs(sourceFile), description : "mixin super method call" },
            { args : consumerSuperMixinMethodArgs(sourceFile), description : "consumer super method call" }
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
            { args : selfMixinStaticPropertyArgs(sourceFile), count : 3, memberName : "mixinStaticProperty", description : "self mixin static property usage" },
            { args : usageArgs(sourceFile, "mixinStaticProperty"), count : 3, memberName : "mixinStaticProperty", description : "external mixin static property usage" },
            { args : usageArgs(sourceFile, "mixinStaticMethod"), count : 2, memberName : "mixinStaticMethod", description : "external mixin static method usage" }
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
        sourceFiles            : [ { fileName : "source.ts", text : consumerClassNameText } ]
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
        sourceFiles            : [ { fileName : "source.ts", text : consumerExtendsLocalBaseText } ]
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
