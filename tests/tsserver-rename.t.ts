import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
import {
    assertRenameAllowed,
    consumerSuperMixinMethodArgs,
    consumerSuperMixinPropertyArgs,
    createEditorFixture,
    request,
    selfMixinMethodArgs,
    selfMixinPropertyArgs,
    selfMixinStaticPropertyArgs,
    superMixinMethodArgs,
    superMixinPropertyArgs,
    usageArgs
} from "./tsserver-editor-util.js"
import type { RenameResponseBody } from "./tsserver-editor-util.js"

const standaloneConstructionText = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    class Serializable extends Base {
        public format?: string = "json"
    }

    const created: Serializable = Serializable.new()
    void created
`)

it("tsserver rename does not crash on a construction-base mixin's generated .new()", async (t: Test) => {
    // Regression: the source-view source file is built from a throwaway clone the
    // program never binds. The generated `static new` carried an `originalNode` to
    // the (clone) class, so rename/go-to-definition on `Serializable.new()` mapped
    // the overload back to that unbound clone via getParseTreeNode and crashed the
    // checker with "Cannot read properties of undefined (reading 'members')".
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: standaloneConstructionText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const newCall    = standaloneConstructionText.indexOf("Serializable.new()") + "Serializable.".length

        const body = assertResponseBody(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                standaloneConstructionText,
                "rename",
                { file: sourceFile, ...positionToLineOffset(standaloneConstructionText, newCall + 1) }
            )
        )

        t.true(body !== undefined, "Rename on a generated .new() responds instead of crashing the checker")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver rename updates mixin method usages from self, external and super calls", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args: selfMixinMethodArgs(sourceFile), description: "self mixin method call" },
            { args: usageArgs(sourceFile, "mixinMethod"), description: "external mixin method call" },
            { args: superMixinMethodArgs(sourceFile), description: "super mixin method call" },
            { args: consumerSuperMixinMethodArgs(sourceFile), description: "consumer super mixin method call" }
        ]) {
            const renamedText = assertRenameAllowed(
                t,
                await request(sourceFile, "rename", scenario.args),
                sourceFile,
                "mixinMethod",
                "renamedMixinMethod"
            )

            t.match(renamedText, "renamedMixinMethod(): string", `Renames declaration from ${scenario.description}`)
            t.match(renamedText, "this.renamedMixinMethod()", `Renames self usage from ${scenario.description}`)
            t.match(renamedText, "mixed.renamedMixinMethod()", `Renames external usage from ${scenario.description}`)
            t.match(renamedText, "super.renamedMixinMethod()", `Renames super usage from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver rename updates plain class members from instance and static usages", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        const renamedPropertyText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseProperty")),
            sourceFile,
            "baseProperty",
            "renamedBaseProperty"
        )

        t.match(renamedPropertyText, "renamedBaseProperty: number", "Renames plain property declaration")
        t.match(renamedPropertyText, "this.renamedBaseProperty", "Renames plain property self usage")
        t.match(renamedPropertyText, "plain.renamedBaseProperty", "Renames plain property external usage")

        const renamedMethodText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseMethod")),
            sourceFile,
            "baseMethod",
            "renamedBaseMethod"
        )

        t.match(renamedMethodText, "renamedBaseMethod(): number", "Renames plain method declaration")
        t.match(renamedMethodText, "plain.renamedBaseMethod()", "Renames plain method external usage")

        const renamedStaticPropertyText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseStaticProperty")),
            sourceFile,
            "baseStaticProperty",
            "renamedBaseStaticProperty"
        )

        t.match(renamedStaticPropertyText, "renamedBaseStaticProperty: number", "Renames plain static property declaration")
        t.match(renamedStaticPropertyText, "this.renamedBaseStaticProperty", "Renames plain static property self usage")
        t.match(renamedStaticPropertyText, "PlainConsumer.renamedBaseStaticProperty", "Renames plain static property external usage")

        const renamedStaticMethodText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "baseStaticMethod")),
            sourceFile,
            "baseStaticMethod",
            "renamedBaseStaticMethod"
        )

        t.match(renamedStaticMethodText, "renamedBaseStaticMethod(): number", "Renames plain static method declaration")
        t.match(renamedStaticMethodText, "PlainConsumer.renamedBaseStaticMethod()", "Renames plain static method external usage")
    } finally {
        await dispose()
    }
})

it("tsserver rename updates mixin property usages from self, external and super accesses", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args: selfMixinPropertyArgs(sourceFile), description: "self mixin property usage" },
            { args: usageArgs(sourceFile, "mixinProperty"), description: "external mixin property usage" },
            { args: superMixinPropertyArgs(sourceFile), description: "super mixin property usage" },
            { args: consumerSuperMixinPropertyArgs(sourceFile), description: "consumer super mixin property usage" }
        ]) {
            const renamedText = assertRenameAllowed(
                t,
                await request(sourceFile, "rename", scenario.args),
                sourceFile,
                "mixinProperty",
                "renamedMixinProperty"
            )

            t.match(renamedText, "renamedMixinProperty: string", `Renames declaration from ${scenario.description}`)
            t.match(renamedText, "this.renamedMixinProperty", `Renames self usage from ${scenario.description}`)
            t.match(renamedText, "mixed.renamedMixinProperty", `Renames external usage from ${scenario.description}`)
            t.match(renamedText, "super.renamedMixinProperty", `Renames super usage from ${scenario.description}`)
        }
    } finally {
        await dispose()
    }
})

it("tsserver rename updates mixin static members from self and external accesses", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args: selfMixinStaticPropertyArgs(sourceFile), description: "self mixin static property usage" },
            { args: usageArgs(sourceFile, "mixinStaticProperty"), description: "external mixin static property usage" }
        ]) {
            const renamedText = assertRenameAllowed(
                t,
                await request(sourceFile, "rename", scenario.args),
                sourceFile,
                "mixinStaticProperty",
                "renamedMixinStaticProperty"
            )

            t.match(renamedText, "renamedMixinStaticProperty: string", `Renames static property declaration from ${scenario.description}`)
            t.match(renamedText, "this.renamedMixinStaticProperty", `Renames static property self usage from ${scenario.description}`)
            t.match(renamedText, "MixinConsumer.renamedMixinStaticProperty", `Renames static property external usage from ${scenario.description}`)
        }

        const renamedMethodText = assertRenameAllowed(
            t,
            await request(sourceFile, "rename", usageArgs(sourceFile, "mixinStaticMethod")),
            sourceFile,
            "mixinStaticMethod",
            "renamedMixinStaticMethod"
        )

        t.match(renamedMethodText, "renamedMixinStaticMethod(): string", "Renames static method declaration")
        t.match(renamedMethodText, "MixinConsumer.renamedMixinStaticMethod()", "Renames static method external usage")
    } finally {
        await dispose()
    }
})

const renameBaseBoundaryText = trimIndent(`
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

    class GenericWidget<T> extends LocalBase implements Feature {
        value?: T
    }
`)

it("tsserver rename of a base class reaches both a non-generic and a generic consumer's extends clause", async (t: Test) => {
    // The navigable-base fast path keeps the REAL `LocalBase` identifier in every
    // consumer's `extends LocalBase` — non-generic AND generic alike (a generic
    // consumer threads its type parameters through the cast's generic construct
    // signature instead of falling back to `$base`) — so renaming the base class
    // updates both occurrences.
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: renameBaseBoundaryText } ]
    })

    try {
        const sourceFile = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const declOffset = positionToLineOffset(renameBaseBoundaryText, renameBaseBoundaryText.indexOf("class LocalBase") + "class ".length)

        const body = assertResponseBody<RenameResponseBody>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, renameBaseBoundaryText, "rename", {
                file : sourceFile,
                ...declOffset
            })
        )

        t.true(body.info?.canRename, "Base class is renameable")

        const spans = (body.locs ?? [])
            .filter((loc) => loc.file === sourceFile)
            .flatMap((loc) => loc.locs)

        const coversBaseNameAt = (extendsIndex: number): boolean => {
            const { line, offset } = positionToLineOffset(renameBaseBoundaryText, extendsIndex + "extends ".length)

            return spans.some((span) => span.start.line === line && span.start.offset === offset)
        }

        const nonGenericExtends = renameBaseBoundaryText.indexOf("extends LocalBase")
        const genericExtends    = renameBaseBoundaryText.indexOf("extends LocalBase", nonGenericExtends + 1)

        t.true(coversBaseNameAt(nonGenericExtends),
            "Rename reaches the non-generic consumer's `extends LocalBase` (navigable-base fast path)")
        t.true(coversBaseNameAt(genericExtends),
            "Rename reaches the generic consumer's `extends LocalBase` (navigable-base fast path, generic form)")
    } finally {
        await fixture.dispose()
    }
})
