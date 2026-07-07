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

// Navigable-base fast path: go-to-definition + quickinfo on the base name in
// `extends <Base>` reach the real base class. Variants beyond the plain-local case:
// a concrete-generic base, a qualified base, a cross-file base, and the formerly
// `$base`-locked consumers (generic, construction, qualified — each an escape route
// of the navigation trilemma). `expectCleanSemantics` additionally pins that the
// rewritten heritage type-checks with no IDE diagnostics.
async function assertBaseNameNavigates(t: Test, options: {
    sourceFiles           : Array<{ fileName: string, text: string }>,
    targetFileName        : string,
    targetText            : string,
    baseNameIndex         : number,
    baseDeclFileName      : string,
    baseDeclText          : string,
    baseDeclNameIndex     : number,
    displayString         : string,
    expectCleanSemantics? : boolean
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

        if (options.expectCleanSemantics === true) {
            const diagnostics = assertResponseBody<Array<{ text?: string }>>(
                t,
                await runTypeScriptServerRequest(fixture.directory, targetFile, options.targetText, "semanticDiagnosticsSync", {
                    file : targetFile
                })
            )

            t.equal(diagnostics.map((diagnostic) => diagnostic.text ?? "").join("\n"), "",
                "The consumer compiles with no IDE diagnostics")
        }

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

// The three formerly `$base`-locked consumers — each an escape route of the navigation
// trilemma (see TODO #4): a GENERIC consumer threads its type parameter through the
// heritage TYPE ARGUMENT of a generic single-source cast (TS2562 bans it only in the
// base expression), a CONSTRUCTION consumer carries the direct-`new` brand inside the
// cast's construct signature, and a QUALIFIED base deep-pins the property-access clone.

it("tsserver navigation on a GENERIC consumer's base name reaches the base class", async (t: Test) => {
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        class LocalBase {
            baseValue: number = 0
        }

        @mixin()
        class Holder<V> {
            stored: V | undefined = undefined

            take(): V | undefined {
                return this.stored
            }
        }

        class Widget<T> extends LocalBase implements Holder<T> {
            grab(): T | undefined {
                return this.take()
            }

            viaSuper(): T | undefined {
                return super.take()
            }
        }

        const widget = new Widget<string>()
        widget.stored = "x"
        const grabbed: string | undefined = widget.grab()
        const viaBase: number = widget.baseValue
        void grabbed
        void viaBase
    `)

    await assertBaseNameNavigates(t, {
        sourceFiles          : [ { fileName: "source.ts", text } ],
        targetFileName       : "source.ts",
        targetText           : text,
        baseNameIndex        : text.indexOf("extends LocalBase") + "extends ".length,
        baseDeclFileName     : "source.ts",
        baseDeclText         : text,
        baseDeclNameIndex    : text.indexOf("class LocalBase") + "class ".length,
        displayString        : "class LocalBase",
        expectCleanSemantics : true
    })
})

it("tsserver navigation on a CONSTRUCTION consumer's base name reaches the base class", async (t: Test) => {
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            modelValue: number = 0
        }

        @mixin()
        class Feature {
            feature?: string
        }

        class Widget extends Model implements Feature {
            widget: boolean = false
        }

        const widget = Widget.new({ widget: true, modelValue: 1, feature: "x" })
        const value: number = widget.modelValue
        void value
    `)

    await assertBaseNameNavigates(t, {
        sourceFiles          : [ { fileName: "source.ts", text } ],
        targetFileName       : "source.ts",
        targetText           : text,
        baseNameIndex        : text.indexOf("extends Model") + "extends ".length,
        baseDeclFileName     : "source.ts",
        baseDeclText         : text,
        baseDeclNameIndex    : text.indexOf("class Model") + "class ".length,
        displayString        : "class Model",
        expectCleanSemantics : true
    })
})

it("tsserver navigation on a QUALIFIED base name (`extends shapes.Base`) reaches the base class", async (t: Test) => {
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

    await assertBaseNameNavigates(t, {
        sourceFiles          : [ { fileName: "source.ts", text } ],
        targetFileName       : "source.ts",
        targetText           : text,
        baseNameIndex        : text.indexOf("extends shapes.Base") + "extends shapes.".length,
        baseDeclFileName     : "source.ts",
        baseDeclText         : text,
        baseDeclNameIndex    : text.indexOf("export class Base") + "export class ".length,
        displayString        : "Base",
        expectCleanSemantics : true
    })
})

it("tsserver navigation works with generic + qualified combined", async (t: Test) => {
    // Generic consumer + qualified base + generic mixin in one shape. (A qualified base
    // is not recognized as a CONSTRUCTION base yet — see TODO "Qualified construction
    // bases" — so this combination instantiates directly.)
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        namespace data {
            export class Model {
                modelValue: number = 0
            }
        }

        @mixin()
        class Holder<V> {
            stored: V | undefined = undefined

            take(): V | undefined {
                return this.stored
            }
        }

        class Widget<T> extends data.Model implements Holder<T> {
            grab(): T | undefined {
                return super.take()
            }
        }

        const widget = new Widget<string>()
        widget.stored = "x"
        const grabbed: string | undefined = widget.grab()
        const viaBase: number = widget.modelValue
        void grabbed
        void viaBase
    `)

    await assertBaseNameNavigates(t, {
        sourceFiles          : [ { fileName: "source.ts", text } ],
        targetFileName       : "source.ts",
        targetText           : text,
        baseNameIndex        : text.indexOf("extends data.Model") + "extends data.".length,
        baseDeclFileName     : "source.ts",
        baseDeclText         : text,
        baseDeclNameIndex    : text.indexOf("export class Model") + "export class ".length,
        displayString        : "Model",
        expectCleanSemantics : true
    })
})

it("tsserver navigation on a mixin's own required-base name (`@mixin ... extends RequiredBase`) reaches the base class", async (t: Test) => {
    // A @mixin's `extends` declares its REQUIRED consumer base. In source view the
    // heritage is rewritten; the navigable fast path must pin the real base reference
    // onto the source token — same guarantee consumers get.
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        class RequiredBase {
            baseValue: number = 0
        }

        @mixin()
        class Tagged extends RequiredBase {
            public tag?: string = ""

            read(): number {
                return this.baseValue
            }
        }

        class User extends RequiredBase implements Tagged {}

        const user = new User()
        const viaBase: number = user.baseValue
        const viaMixin: string | undefined = user.tag
        void viaBase
        void viaMixin
    `)

    await assertBaseNameNavigates(t, {
        sourceFiles          : [ { fileName: "source.ts", text } ],
        targetFileName       : "source.ts",
        targetText           : text,
        baseNameIndex        : text.indexOf("class Tagged extends RequiredBase") + "class Tagged extends ".length,
        baseDeclFileName     : "source.ts",
        baseDeclText         : text,
        baseDeclNameIndex    : text.indexOf("class RequiredBase") + "class ".length,
        displayString        : "class RequiredBase",
        expectCleanSemantics : true
    })
})

it("tsserver navigation on a generic mixin's generic required-base name (`@mixin M<T> extends Store<T>`) reaches the base class", async (t: Test) => {
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        class Store<V> {
            stored: V | undefined = undefined
        }

        @mixin()
        class Keeper<T> extends Store<T> {
            keep(value: T): void {
                this.stored = value
            }
        }

        class Vault<T> extends Store<T> implements Keeper<T> {}

        const vault = new Vault<string>()
        vault.keep("x")
        const kept: string | undefined = vault.stored
        void kept
    `)

    await assertBaseNameNavigates(t, {
        sourceFiles          : [ { fileName: "source.ts", text } ],
        targetFileName       : "source.ts",
        targetText           : text,
        baseNameIndex        : text.indexOf("class Keeper<T> extends Store<T>") + "class Keeper<T> extends ".length,
        baseDeclFileName     : "source.ts",
        baseDeclText         : text,
        baseDeclNameIndex    : text.indexOf("class Store<V>") + "class ".length,
        displayString        : "class Store<V>",
        expectCleanSemantics : true
    })
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
