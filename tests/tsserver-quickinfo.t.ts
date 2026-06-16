import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile } from "./util.js"
import {
    assertFixtureLikeQuickInfo,
    assertImportedQuickInfo,
    assertQuickInfo,
    consumerSuperMixinMethodArgs,
    consumerSuperMixinPropertyArgs,
    createEditorFixture,
    fixtureLikeConsumerText,
    fixtureLikeMixinsText,
    fixtureLikeSuperMethod1Args,
    fixtureLikeSuperValue2Args,
    importedConsumerSuperMethodArgs,
    importedConsumerSuperPropertyArgs,
    importedConsumerText,
    importedMixinText,
    selfMixinPropertyArgs,
    selfMixinStaticPropertyArgs,
    superMixinMethodArgs,
    superMixinPropertyArgs
} from "./tsserver-editor-util.js"

it("tsserver quickinfo reports plain and mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertQuickInfo(t, sourceFile, "baseProperty", [ "baseProperty: number", "PlainBase.baseProperty" ])
        await assertQuickInfo(t, sourceFile, "baseMethod", [ "baseMethod(): number", "PlainBase.baseMethod" ])
        await assertQuickInfo(t, sourceFile, "baseStaticProperty", [ "baseStaticProperty: number" ])
        await assertQuickInfo(t, sourceFile, "baseStaticMethod", [ "baseStaticMethod(): number" ])
        await assertQuickInfo(t, sourceFile, "mixinProperty", [ "(property)", "mixinProperty: string" ])
        await assertQuickInfo(t, sourceFile, "mixinMethod", [ "(method)", "mixinMethod(): string" ])
        await assertQuickInfo(t, sourceFile, "mixinStaticProperty", [ "(property)", "mixinStaticProperty: string" ])
        await assertQuickInfo(t, sourceFile, "mixinStaticMethod", [ "(method)", "mixinStaticMethod(): string" ])
        await assertQuickInfo(t, sourceFile, "mixinProperty", [ "(property)", "mixinProperty: string" ], selfMixinPropertyArgs(sourceFile))
        await assertQuickInfo(t, sourceFile, "mixinStaticProperty", [ "(property)", "mixinStaticProperty: string" ], selfMixinStaticPropertyArgs(sourceFile))
        await assertQuickInfo(t, sourceFile, "mixinProperty", [ "(property)", "mixinProperty: string" ], superMixinPropertyArgs(sourceFile))
        await assertQuickInfo(t, sourceFile, "mixinMethod", [ "(method)", "mixinMethod(): string" ], superMixinMethodArgs(sourceFile))
        await assertQuickInfo(t, sourceFile, "mixinProperty", [ "(property)", "mixinProperty: string" ], consumerSuperMixinPropertyArgs(sourceFile))
        await assertQuickInfo(t, sourceFile, "mixinMethod", [ "(method)", "mixinMethod(): string" ], consumerSuperMixinMethodArgs(sourceFile))
    } finally {
        await dispose()
    }
})

it("tsserver quickinfo reports consumer super members from imported mixins", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : importedConsumerText
            },
            {
                fileName : "mixins.ts",
                text     : importedMixinText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        await assertImportedQuickInfo(t, sourceFile, [ "(property)", "importedProperty: string" ], importedConsumerSuperPropertyArgs(sourceFile))
        await assertImportedQuickInfo(t, sourceFile, [ "(method)", "importedMethod(): string" ], importedConsumerSuperMethodArgs(sourceFile))
    } finally {
        await fixture.dispose()
    }
})

it("tsserver quickinfo reports fixture-like consumer super members from imported generic mixins", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : fixtureLikeConsumerText
            },
            {
                fileName : "mixins.ts",
                text     : fixtureLikeMixinsText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        await assertFixtureLikeQuickInfo(t, sourceFile, [ "(property)", "value2: string" ], fixtureLikeSuperValue2Args(sourceFile))
        await assertFixtureLikeQuickInfo(t, sourceFile, [ "(method)", "method1(): string" ], fixtureLikeSuperMethod1Args(sourceFile))
    } finally {
        await fixture.dispose()
    }
})
