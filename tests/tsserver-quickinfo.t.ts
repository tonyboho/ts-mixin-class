import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
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
    positionToIndex,
    type QuickInfoBody,
    selfMixinPropertyArgs,
    selfMixinStaticPropertyArgs,
    sourceSlice,
    superMixinMethodArgs,
    superMixinPropertyArgs
} from "./tsserver-editor-util.js"

const constructionConsumerText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base, type Config } from "ts-mixin-class/base"

    class ConstructableBase extends Base {
        public baseValue: string = "base"
    }

    @mixin()
    class ConstructableMixin {
        public mixinValue: number = 0
    }

    class ConstructableConsumer extends ConstructableBase implements ConstructableMixin {
        public ownValue: boolean = false

        override initialize(config?: Config<this>): void {
            super.initialize(config)
        }
    }

    ConstructableConsumer.new({
        baseValue  : "configured",
        mixinValue : 42,
        ownValue   : true
    })
`)

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

it("tsserver quickinfo reports construction base class declarations", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : constructionConsumerText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const classNamePosition = constructionConsumerText.indexOf("ConstructableBase extends")

        if (classNamePosition < 0) {
            t.fail("Cannot find ConstructableBase declaration.")
            return
        }

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                constructionConsumerText,
                "quickinfo",
                {
                    file : sourceFile,
                    ...positionToLineOffset(constructionConsumerText, classNamePosition + 1)
                }
            )
        )

        t.match(quickInfo.displayString ?? "", "class ConstructableBase",
            "QuickInfo reports the source construction base class declaration")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver quickinfo reports mixin consumer class declarations", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : constructionConsumerText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const classNamePosition = constructionConsumerText.indexOf("ConstructableConsumer extends")

        if (classNamePosition < 0) {
            t.fail("Cannot find ConstructableConsumer declaration.")
            return
        }

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                constructionConsumerText,
                "quickinfo",
                {
                    file : sourceFile,
                    ...positionToLineOffset(constructionConsumerText, classNamePosition + 1)
                }
            )
        )

        t.match(quickInfo.displayString ?? "", "class ConstructableConsumer",
            "QuickInfo reports the source consumer class declaration")
        t.equal(
            positionToIndex(constructionConsumerText, quickInfo.start),
            classNamePosition,
            "QuickInfo span starts at the consumer class name"
        )
        t.equal(
            sourceSlice(constructionConsumerText, quickInfo),
            "ConstructableConsumer",
            "QuickInfo span covers only the consumer class name"
        )
    } finally {
        await fixture.dispose()
    }
})

const mixinBaseMemberText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Mixin1 extends Base {
        prop: string = ""

        check(): boolean {
            return this.prop === ""
        }
    }

    @mixin()
    class Mixin2 {
        prop: string = ""

        check(): boolean {
            return this.prop === ""
        }
    }
`)

it("tsserver quickinfo reports a mixin's own member used in a method, even when the mixin extends Base", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : mixinBaseMemberText
            }
        ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        const propQuickInfo = async (occurrence: number): Promise<QuickInfoBody> => {
            let index = -1

            for (let i = 0; i < occurrence; i++) {
                index = mixinBaseMemberText.indexOf("this.prop", index + 1)
            }

            return assertResponseBody<QuickInfoBody>(
                t,
                await runTypeScriptServerRequest(
                    fixture.directory,
                    sourceFile,
                    mixinBaseMemberText,
                    "quickinfo",
                    {
                        file : sourceFile,
                        ...positionToLineOffset(mixinBaseMemberText, index + "this.".length)
                    }
                )
            )
        }

        // Mixin1 extends Base — this is the regressing case.
        const baseMixin = await propQuickInfo(1)

        t.match(baseMixin.displayString ?? "", "prop", "this.prop in a Base-extending mixin resolves to the property")
        t.match(baseMixin.displayString ?? "", "string", "...and reports its type")

        // Mixin2 has no base — the control that already works.
        const plainMixin = await propQuickInfo(2)

        t.match(plainMixin.displayString ?? "", "prop", "this.prop in a plain mixin resolves to the property")
    } finally {
        await fixture.dispose()
    }
})
