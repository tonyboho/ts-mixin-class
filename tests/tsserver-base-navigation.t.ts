import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
import type { DefinitionInfo, QuickInfoBody, RenameResponseBody, TextSpan } from "./tsserver-editor-util.js"

// BASE-NAME NAVIGATION in a rewritten heritage clause (USE-CASES §12.8): go-to-definition,
// find-all-references, rename and quickinfo on the base name in `extends <Base>` reach the
// real base class for every well-typed class with an explicit entity-name base — plain,
// GENERIC, CONSTRUCTION and QUALIFIED consumers, cross-file bases, and a `@mixin` class's
// own required-base heritage. See AGENTS.md "Heritage-clause navigation" for the mechanism
// (the navigable single-source cast) and the DELIBERATE residual empties.

type ReferencesBody = {
    refs? : Array<TextSpan & {
        file          : string,
        isDefinition? : boolean
    }>
}

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
    // `$base`. The navigable-base fast path re-extends the real base under a
    // single-source cast (`extends (LocalBase as unknown as <cast>)`), keeping the
    // real `LocalBase` identifier on its source position. The generic /
    // construction / qualified variants are pinned by the `assertBaseNameNavigates`
    // tests below.
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

        t.true(
            definitions.some(landsOnDeclaration),
            "Go-to-definition on the base name in `extends LocalBase` lands on `class LocalBase`"
        )

        t.true(
            references.some(landsOnDeclaration),
            "Find-all-references from the base name in `extends LocalBase` includes the `class LocalBase` declaration"
        )

        t.equal(
            quickInfo.displayString,
            "class LocalBase",
            "Quickinfo on the base name in `extends LocalBase` reports the base class, not the internal `$base`"
        )
    } finally {
        await fixture.dispose()
    }
})

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

            t.equal(
                diagnostics.map((diagnostic) => diagnostic.text ?? "").join("\n"),
                "",
                "The consumer compiles with no IDE diagnostics"
            )
        }

        const definitions = assertResponseBody<DefinitionInfo[]>(
            t,
            await runTypeScriptServerRequest(fixture.directory, targetFile, options.targetText, "definition", {
                file : targetFile,
                ...baseOffset
            })
        )

        t.true(
            definitions.some((definition) =>
                (definition.file === undefined || definition.file === declFile) &&
                definition.start.line === declPos.line &&
                definition.start.offset === declPos.offset),
            `Go-to-definition on the base name lands on its declaration\n${JSON.stringify(definitions)}`
        )

        const quickInfo = assertResponseBody<QuickInfoBody>(
            t,
            await runTypeScriptServerRequest(fixture.directory, targetFile, options.targetText, "quickinfo", {
                file : targetFile,
                ...baseOffset
            })
        )

        t.match(
            quickInfo.displayString ?? "",
            options.displayString,
            `Quickinfo on the base name reports the real base class\n${quickInfo.displayString}`
        )
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

// The three formerly `$base`-locked consumers — each an escape route of the navigation
// trilemma (see AGENTS.md "Heritage-clause navigation"): a GENERIC consumer threads its type parameter through the
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
            public modelValue: number = 0
        }

        @mixin()
        class Feature {
            public feature?: string
        }

        class Widget extends Model implements Feature {
            public widget: boolean = false
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
    // Generic consumer + qualified base + generic mixin in one shape. (`data.Model` does
    // not extend the package `Base`, so this combination instantiates directly; the
    // qualified CONSTRUCTION-base case is pinned by the construction-qualified fixtures.)
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

        t.true(
            coversBaseNameAt(nonGenericExtends),
            "Rename reaches the non-generic consumer's `extends LocalBase` (navigable-base fast path)"
        )
        t.true(
            coversBaseNameAt(genericExtends),
            "Rename reaches the generic consumer's `extends LocalBase` (navigable-base fast path, generic form)"
        )
    } finally {
        await fixture.dispose()
    }
})
