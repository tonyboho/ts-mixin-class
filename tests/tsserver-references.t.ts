import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertResponseBody } from "./tsserver-util.js"
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
import type { TextSpan } from "./tsserver-editor-util.js"

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
