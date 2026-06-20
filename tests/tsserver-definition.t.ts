import { it, xit } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
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

type ManualMixDefinition = {
    file  : string,
    start : { line: number, offset: number }
}

// Go-to-definition on a member reached through a manual `.mix(Base)` of a *dependent* mixin
// (`class X extends Main.mix(UserBase)` where `@mixin() Main implements Dep`). Unlike the
// `implements`-consumer path above (which resolves to the real declaration), the member here
// is reached through the synthetic `.mix` apply type, whose instance members are collapsed to
// a non-source range to dodge a source-view crash — so definition lands on the wrong span
// (for a dependent mixin, even a different class) instead of `Main.mainMethod`.
//
// SKIPPED (xit) — known limitation, fix deferred. Resolving to the real declaration needs the
// instance type to reference the mixin by name, but `.mix` lives in the mixin's own base
// expression, so naming it there is a self-base-reference (TS2506/TS2310). See the Open
// questions entry in USE-CASES.md for the trilemma and the deeper-fix options.
const manualMixDependencyText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Dep {
        depMethod(): string {
            return "dep"
        }
    }

    @mixin()
    class Main implements Dep {
        mainMethod(): string {
            return "main/" + super.depMethod()
        }
    }

    class UserBase {
        prefix: string = ""
    }

    class ManualWithDependency extends Main.mix(UserBase) {
        combined(): string {
            return this.mainMethod() + "/" + this.depMethod()
        }
    }

    void new ManualWithDependency()
`)

function manualMixUsageArgs(sourceFile: string, access: string, memberName: string): { file: string, line: number, offset: number } {
    const accessIndex = manualMixDependencyText.indexOf(access)

    if (accessIndex < 0) {
        throw new Error(`Cannot find usage "${access}".`)
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(manualMixDependencyText, accessIndex + access.length - memberName.length)
    }
}

function manualMixDefinitionLands(definitions: ManualMixDefinition[], sourceFile: string, declarationText: string): boolean {
    const lines = manualMixDependencyText.split("\n")

    return definitions.some((definition) => {
        return definition.file === sourceFile &&
            (lines[definition.start.line - 1] ?? "").slice(definition.start.offset - 1).startsWith(declarationText)
    })
}

xit("tsserver go-to-definition resolves a member reached through a manual .mix of a dependent mixin", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: manualMixDependencyText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")

        const mainDefinitions = assertResponseBody<ManualMixDefinition[]>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, manualMixDependencyText, "definition", manualMixUsageArgs(sourceFile, "this.mainMethod", "mainMethod"))
        )

        t.true(
            manualMixDefinitionLands(mainDefinitions, sourceFile, "mainMethod(): string"),
            "this.mainMethod() resolves to Main.mainMethod's own declaration"
        )

        const depDefinitions = assertResponseBody<ManualMixDefinition[]>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, manualMixDependencyText, "definition", manualMixUsageArgs(sourceFile, "this.depMethod", "depMethod"))
        )

        t.true(
            manualMixDefinitionLands(depDefinitions, sourceFile, "depMethod(): string"),
            "this.depMethod() resolves to Dep.depMethod's declaration"
        )
    } finally {
        await fixture.dispose()
    }
})
