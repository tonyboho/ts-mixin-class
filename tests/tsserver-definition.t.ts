import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile } from "./util.js"
import {
    assertDefinition,
    assertDefinitionAndBoundSpan,
    assertFixtureLikeDefinition,
    assertFixtureLikeDefinitionAndBoundSpan,
    assertImportedDefinition,
    assertImportedDefinitionAndBoundSpan,
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
    superMixinPropertyArgs,
    usageArgs
} from "./tsserver-editor-util.js"

it("tsserver definition resolves plain and mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertDefinition(t, sourceFile, "baseProperty", "baseProperty: number", "Plain base property")
        await assertDefinition(t, sourceFile, "baseMethod", "baseMethod(): number", "Plain base method")
        await assertDefinition(t, sourceFile, "baseStaticProperty", "baseStaticProperty: number", "Plain base static property")
        await assertDefinition(t, sourceFile, "baseStaticMethod", "baseStaticMethod(): number", "Plain base static method")
        await assertDefinition(t, sourceFile, "mixinProperty", "mixinProperty: string", "Mixin property")
        await assertDefinition(t, sourceFile, "mixinMethod", "mixinMethod(): string", "Mixin method")
        await assertDefinition(t, sourceFile, "mixinStaticProperty", "mixinStaticProperty: string", "Mixin static property")
        await assertDefinition(t, sourceFile, "mixinStaticMethod", "mixinStaticMethod(): string", "Mixin static method")
        await assertDefinition(t, sourceFile, "mixinProperty", "mixinProperty: string", "Mixin self property", selfMixinPropertyArgs(sourceFile))
        await assertDefinition(t, sourceFile, "mixinStaticProperty", "mixinStaticProperty: string", "Mixin static self property", selfMixinStaticPropertyArgs(sourceFile))
        await assertDefinition(t, sourceFile, "mixinProperty", "mixinProperty: string", "Mixin super property", superMixinPropertyArgs(sourceFile))
        await assertDefinition(t, sourceFile, "mixinMethod", "mixinMethod(): string", "Mixin super method", superMixinMethodArgs(sourceFile))
        await assertDefinition(t, sourceFile, "mixinProperty", "mixinProperty: string", "Consumer super property", consumerSuperMixinPropertyArgs(sourceFile))
        await assertDefinition(t, sourceFile, "mixinMethod", "mixinMethod(): string", "Consumer super method", consumerSuperMixinMethodArgs(sourceFile))
    } finally {
        await dispose()
    }
})

it("tsserver definitionAndBoundSpan resolves super mixin members", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        await assertDefinitionAndBoundSpan(t, sourceFile, "mixinProperty", "mixinProperty: string", "Mixin super property", superMixinPropertyArgs(sourceFile))
        await assertDefinitionAndBoundSpan(t, sourceFile, "mixinMethod", "mixinMethod(): string", "Mixin super method", superMixinMethodArgs(sourceFile))
        await assertDefinitionAndBoundSpan(t, sourceFile, "mixinProperty", "mixinProperty: string", "Consumer super property", consumerSuperMixinPropertyArgs(sourceFile))
        await assertDefinitionAndBoundSpan(t, sourceFile, "mixinMethod", "mixinMethod(): string", "Consumer super method", consumerSuperMixinMethodArgs(sourceFile))
        // eslint-disable-next-line max-len
        await assertDefinitionAndBoundSpan(t, sourceFile, "baseStaticProperty", "baseStaticProperty: number", "Plain base static property", usageArgs(sourceFile, "baseStaticProperty"))
        await assertDefinitionAndBoundSpan(t, sourceFile, "baseStaticMethod", "baseStaticMethod(): number", "Plain base static method", usageArgs(sourceFile, "baseStaticMethod"))
        // eslint-disable-next-line max-len
        await assertDefinitionAndBoundSpan(t, sourceFile, "mixinStaticProperty", "mixinStaticProperty: string", "Mixin static self property", selfMixinStaticPropertyArgs(sourceFile))
        // eslint-disable-next-line max-len
        await assertDefinitionAndBoundSpan(t, sourceFile, "mixinStaticProperty", "mixinStaticProperty: string", "Mixin static property", usageArgs(sourceFile, "mixinStaticProperty"))
        await assertDefinitionAndBoundSpan(t, sourceFile, "mixinStaticMethod", "mixinStaticMethod(): string", "Mixin static method", usageArgs(sourceFile, "mixinStaticMethod"))
    } finally {
        await dispose()
    }
})

it("tsserver definition resolves consumer super members from imported mixins", async (t: Test) => {
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
        const mixinFile  = requiredFixtureSourceFile(fixture.sourceFiles, "mixins.ts")

        await assertImportedDefinition(t, sourceFile, mixinFile, "importedProperty", "importedProperty: string", importedConsumerSuperPropertyArgs(sourceFile))
        await assertImportedDefinition(t, sourceFile, mixinFile, "importedMethod", "importedMethod(): string", importedConsumerSuperMethodArgs(sourceFile))
        await assertImportedDefinitionAndBoundSpan(t, sourceFile, mixinFile, "importedProperty", "importedProperty: string", importedConsumerSuperPropertyArgs(sourceFile))
        await assertImportedDefinitionAndBoundSpan(t, sourceFile, mixinFile, "importedMethod", "importedMethod(): string", importedConsumerSuperMethodArgs(sourceFile))
    } finally {
        await fixture.dispose()
    }
})

it("tsserver definition resolves fixture-like consumer super members from imported generic mixins", async (t: Test) => {
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
        const mixinFile  = requiredFixtureSourceFile(fixture.sourceFiles, "mixins.ts")

        await assertFixtureLikeDefinition(t, sourceFile, mixinFile, "value2", "value2: string", fixtureLikeSuperValue2Args(sourceFile))
        await assertFixtureLikeDefinition(t, sourceFile, mixinFile, "method1", "method1(): string", fixtureLikeSuperMethod1Args(sourceFile))
        await assertFixtureLikeDefinitionAndBoundSpan(t, sourceFile, mixinFile, "value2", "value2: string", fixtureLikeSuperValue2Args(sourceFile))
        await assertFixtureLikeDefinitionAndBoundSpan(t, sourceFile, mixinFile, "method1", "method1(): string", fixtureLikeSuperMethod1Args(sourceFile))
    } finally {
        await fixture.dispose()
    }
})
