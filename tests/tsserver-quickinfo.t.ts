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

const constructionBaseMixinText = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    class Serializable extends Base {
        public format?: string = "json"
    }
`)

it("tsserver quickinfo does not crash on a construction-base mixin's class name", async (t: Test) => {
    // Regression: a mixin that `extends Base` generates a position-preserving
    // source-view interface and shadow class. Their text range started at the
    // original class `.pos`, which includes the leading `@mixin()` decorator,
    // while their first child is the name (no decorator) — so the decorator's
    // `mixin` identifier was stranded in the generated node's trivia gap, and
    // tsserver's getTokenAtPosition / getChildren threw "Did not expect
    // InterfaceDeclaration to have an Identifier in its trivia", failing
    // quickinfo (and rename) on the mixin name.
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : constructionBaseMixinText } ]
    })

    try {
        const sourceFile   = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const namePosition = constructionBaseMixinText.indexOf("Serializable extends")

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                constructionBaseMixinText,
                "quickinfo",
                { file : sourceFile, ...positionToLineOffset(constructionBaseMixinText, namePosition + 1) }
            )
        )

        t.match(quickInfo.displayString ?? "", "class Serializable",
            "QuickInfo on a construction-base mixin name reports its class declaration instead of crashing")
        t.equal(positionToIndex(constructionBaseMixinText, quickInfo.start), namePosition,
            "QuickInfo highlight starts exactly at the mixin name")
        t.equal(sourceSlice(constructionBaseMixinText, quickInfo), "Serializable",
            "QuickInfo highlight covers exactly the mixin name")
    } finally {
        await fixture.dispose()
    }
})

// Each of the following reproduces a distinct source-view "Did not expect <kind>
// to have an Identifier in its trivia" crash (source-view invariants #5 / #8): a
// generated declaration stranded a source identifier in a `SyntaxList` trivia gap,
// so tsserver's getTokenAtPosition / getChildren threw when quickinfo navigated to
// the named class. The shared whole-suite guard is `source-view-trivia.t.ts`; these
// pin the individual generation sites at the tsserver layer. `assertResponseBody`
// fails on the tsserver error, so a regression surfaces as a failed quickinfo here.
async function assertQuickInfoOnClassNameDoesNotCrash(
    t: Test,
    text: string,
    className: string,
    expectedDisplay: string
): Promise<void> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text } ]
    })

    try {
        const sourceFile   = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const namePosition = text.indexOf(className)

        if (namePosition < 0) {
            t.fail(`Cannot find ${className} declaration.`)
            return
        }

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                text,
                "quickinfo",
                { file : sourceFile, ...positionToLineOffset(text, namePosition + 1) }
            )
        )

        t.match(quickInfo.displayString ?? "", expectedDisplay,
            `QuickInfo on ${className} reports its declaration instead of crashing`)
        t.equal(positionToIndex(text, quickInfo.start), namePosition,
            `QuickInfo highlight starts exactly at ${className}`)
        t.equal(sourceSlice(text, quickInfo), className,
            `QuickInfo highlight covers exactly ${className}`)
    } finally {
        await fixture.dispose()
    }
}

const manualMixApplyText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Named {
        static mixinStatic(): string {
            return "mixinStatic"
        }

        label(): string {
            return "label"
        }
    }

    class NamedUserBase {
        prefix: string = ""
    }

    class ManualUser extends Named.mix(NamedUserBase) {}
`)

it("tsserver quickinfo does not crash on a mixin used with manual .mix() syntax", async (t: Test) => {
    // Regression (apply type): the source-view `.mix` apply type deep-clones the
    // mixin's member signatures, which keep their source positions inside the
    // metadata-base cast and stranded the cloned member names (`mixinStatic`,
    // `label`) in a SyntaxList trivia gap.
    await assertQuickInfoOnClassNameDoesNotCrash(t, manualMixApplyText, "Named", "class Named")
})

const implementsOnlyConsumerText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Boxed<T> {
        value?: T
    }

    @mixin()
    class Labeled<A> {
        label?: A
    }

    class Combined<T, A> implements Boxed<T>, Labeled<A> {}
`)

it("tsserver quickinfo does not crash on an implements-only mixin consumer", async (t: Test) => {
    // Regression (implements-only consumer): the dropped `implements` clause and the
    // generated `extends $base` / metadata cast stretched over the multi-type
    // `implements Boxed<T>, Labeled<A>` stranded the source types and their `<...>`
    // arguments.
    await assertQuickInfoOnClassNameDoesNotCrash(t, implementsOnlyConsumerText, "Combined", "class Combined")
})

const genericConstructionText = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    class Container<T> extends Base {
        item?: T
    }
`)

it("tsserver quickinfo does not crash on a generic construction-base mixin", async (t: Test) => {
    // Regression (generic construction `static new<T>`): the generated overload
    // deep-clones the class type parameters, which kept their source positions while
    // the method was pinned to a tiny synthetic range, stranding `T`.
    await assertQuickInfoOnClassNameDoesNotCrash(t, genericConstructionText, "Container", "class Container")
})

const genericConsumerTypeParametersText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Boxed<T> {
        value?: T
    }

    @mixin()
    class Labeled<A> {
        label?: A
    }

    class Combined<T, A> implements Boxed<T>, Labeled<A> {}
`)

it("tsserver quickinfo highlights exactly the consumer's second type parameter", async (t: Test) => {
    // Regression (source-view type-parameter ranges): every generated type-parameter
    // clone was pinned to the whole `<T, A>` list range, so the clones overlapped.
    // Hovering the second parameter `A` resolved to the first (`T`) with a span
    // covering the entire list. Each clone now maps onto its own source parameter.
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : genericConsumerTypeParametersText } ]
    })

    try {
        const sourceFile    = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const paramPosition = genericConsumerTypeParametersText.indexOf("Combined<T, A>") + "Combined<T, ".length

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                genericConsumerTypeParametersText,
                "quickinfo",
                { file : sourceFile, ...positionToLineOffset(genericConsumerTypeParametersText, paramPosition) }
            )
        )

        t.match(quickInfo.displayString ?? "", "(type parameter) A",
            "QuickInfo on the second type parameter resolves to it, not the first")
        t.equal(positionToIndex(genericConsumerTypeParametersText, quickInfo.start), paramPosition,
            "QuickInfo highlight starts exactly at the second type parameter")
        t.equal(sourceSlice(genericConsumerTypeParametersText, quickInfo), "A",
            "QuickInfo highlight covers exactly the second type parameter")
    } finally {
        await fixture.dispose()
    }
})

const mixinExtendsMixinText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Animal {
        species?: string
    }

    @mixin()
    class Dog extends Animal {
        breed?: string
    }
`)

it("tsserver quickinfo highlights exactly a mixin's source base type name", async (t: Test) => {
    // Regression (source-view mixin heritage range): a mixin's `extends Animal` is
    // rewritten to `extends Dog$base`, whose generated reference spanned the whole
    // heritage clause — hovering the source `Animal` highlighted all of
    // `extends Animal`. The generated reference is now pinned onto the source base
    // type name, so the highlight lands exactly on it. (The displayString is the
    // generated `$base`, which these decorated `$base` helpers report as `any`; the
    // guard here is the span, mirroring stress-quickinfo.)
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName : "source.ts", text : mixinExtendsMixinText } ]
    })

    try {
        const sourceFile   = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const basePosition = mixinExtendsMixinText.indexOf("extends Animal") + "extends ".length

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                mixinExtendsMixinText,
                "quickinfo",
                { file : sourceFile, ...positionToLineOffset(mixinExtendsMixinText, basePosition) }
            )
        )

        t.equal(positionToIndex(mixinExtendsMixinText, quickInfo.start), basePosition,
            "QuickInfo highlight starts exactly at the source base type name")
        t.equal(sourceSlice(mixinExtendsMixinText, quickInfo), "Animal",
            "QuickInfo highlight covers exactly the source base type name")
    } finally {
        await fixture.dispose()
    }
})

const badLinearizationText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin() class LinA {}
    @mixin() class LinB {}
    @mixin() class LinX implements LinA, LinB {}
    @mixin() class LinY implements LinB, LinA {}
    @mixin() class BadLinearizationMixin implements LinX, LinY {}

    // @ts-expect-error BadLinearizationMixin has inconsistent C3 requirements.
    class BadLinearizationConsumer implements BadLinearizationMixin {}
`)

it("tsserver quickinfo does not crash on a consumer whose mixins fail C3 linearization", async (t: Test) => {
    // Regression (diagnostic `$base` path): a consumer whose mixins fail C3
    // linearization built its diagnostic `$base` with the throwaway emit range, so
    // the cloned heritage's source positions expanded the helper over the consumer
    // and stranded its name.
    await assertQuickInfoOnClassNameDoesNotCrash(
        t,
        badLinearizationText,
        "BadLinearizationConsumer",
        "class BadLinearizationConsumer"
    )
})
