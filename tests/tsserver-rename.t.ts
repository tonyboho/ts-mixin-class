import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

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

it("tsserver rename updates mixin method usages from self, external and super calls", async (t: Test) => {
    const { sourceFile, dispose } = await createEditorFixture()

    try {
        for (const scenario of [
            { args : selfMixinMethodArgs(sourceFile), description : "self mixin method call" },
            { args : usageArgs(sourceFile, "mixinMethod"), description : "external mixin method call" },
            { args : superMixinMethodArgs(sourceFile), description : "super mixin method call" },
            { args : consumerSuperMixinMethodArgs(sourceFile), description : "consumer super mixin method call" }
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
            { args : selfMixinPropertyArgs(sourceFile), description : "self mixin property usage" },
            { args : usageArgs(sourceFile, "mixinProperty"), description : "external mixin property usage" },
            { args : superMixinPropertyArgs(sourceFile), description : "super mixin property usage" },
            { args : consumerSuperMixinPropertyArgs(sourceFile), description : "consumer super mixin property usage" }
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
            { args : selfMixinStaticPropertyArgs(sourceFile), description : "self mixin static property usage" },
            { args : usageArgs(sourceFile, "mixinStaticProperty"), description : "external mixin static property usage" }
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
