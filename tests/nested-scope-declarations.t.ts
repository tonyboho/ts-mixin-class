import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { transformSourceFile } from "../src/index.js"
import type { NativeMixinDiagnostic } from "../src/model.js"
import { commandOutput, createSourceFile, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"

// A class declared inside a function body / block — not a top-level statement — should expand
// like a top-level one. The relaxation treats a mixin consumer and a `@mixin` uniformly: both
// are just "a new kind of class" and must work wherever a class can be declared. Such a nested
// class cannot be exported (it is a local), which is the only thing it gives up.

// Build the fixture through the real patched `tsc` (the emit plane: program transform + checker)
// and import the emitted JS to assert runtime behaviour.
async function buildAndImport(t: Test, text: string): Promise<Record<string, unknown>> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })

    const result = await runCommand(
        "node",
        [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
        fixture.directory
    )

    t.equal(result.exitCode, 0, `Nested declaration builds.\n${commandOutput(result)}`)

    const moduleUrl = pathToFileURL(path.join(fixture.directory, "dist", "source.js")).href
    const imported  = await import(moduleUrl) as Record<string, unknown>

    // The fixture directory is intentionally left for the import to resolve; siesta's process
    // exit cleans the OS temp dir. (Other fixture tests dispose explicitly; here the dynamic
    // import keeps the module live, so disposal races the loader.)
    void fixture

    return imported
}

// M1 — a named consumer of a top-level mixin, declared inside a function body, expands and its
// mixin members are present at runtime.
it("expands a mixin consumer declared inside a function body (emit + runtime)", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Tagger {
            tag (value: string): string { return "[" + value + "]" }
        }

        function build (): string {
            class LocalConsumer implements Tagger {}

            return new LocalConsumer().tag("a")
        }

        export const result = build()
    `)

    t.equal(imported.result, "[a]", "the nested consumer received the mixin's `tag` member at runtime")
})

// M2 — a named `@mixin`, declared inside a function body, expands and is consumable locally
// (consumer in the same scope). Consumer == mixin: both relax together.
it("expands a @mixin declared inside a function body, consumed locally (emit + runtime)", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { mixin } from "ts-mixin-class"

        function build (): string {
            @mixin()
            class LocalMixin {
                greet (): string { return "hi" }
            }

            class LocalConsumer implements LocalMixin {}

            return new LocalConsumer().greet()
        }

        export const result = build()
    `)

    t.equal(imported.result, "hi", "the nested mixin was registered and its member ran through the local consumer")
})

// M3 — the generated siblings (`__LocalConsumer$base`, the merged interface, the `defineMixinClass`
// call) land in the SAME block as the class, never leaking to module scope.
it("emits generated siblings into the containing block, not module scope", async (t: Test) => {
    const transformed = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Tagger {
            tag (value: string): string { return value }
        }

        function build () {
            class LocalConsumer implements Tagger {}

            return new LocalConsumer()
        }
        void build
    `))

    const topLevelClassNames = transformed.statements
        .filter(ts.isClassDeclaration)
        .map((declaration) => declaration.name?.text)

    t.notOk(
        topLevelClassNames.includes("__LocalConsumer$base"),
        "the generated base does not leak into module-level statements"
    )
    t.notOk(
        topLevelClassNames.includes("LocalConsumer"),
        "the nested consumer itself stays nested, not hoisted to module scope"
    )

    const build = transformed.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === "build"
    )

    const blockStatements: readonly ts.Statement[] = build?.body?.statements ?? []
    const blockClassNames                          = blockStatements
        .filter(ts.isClassDeclaration)
        .map((declaration) => declaration.name?.text)

    t.ok(
        blockClassNames.includes("__LocalConsumer$base"),
        "the generated intermediate base is emitted inside the function block"
    )
    t.ok(
        blockClassNames.includes("LocalConsumer"),
        "the rewritten consumer stays inside the function block"
    )
})

// M4 — two same-named nested `@mixin`s in sibling scopes both expand from their OWN declaration.
// The flat by-name registry resolves only one; detection by declaration node fixes the second.
it("expands two same-named nested mixins in sibling scopes independently", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { mixin } from "ts-mixin-class"

        function buildA (): string {
            @mixin()
            class Widget {
                a (): string { return "A" }
            }

            class UseA implements Widget {}

            return new UseA().a()
        }

        function buildB (): string {
            @mixin()
            class Widget {
                b (): string { return "B" }
            }

            class UseB implements Widget {}

            return new UseB().b()
        }

        export const ra = buildA()
        export const rb = buildB()
    `)

    t.equal(imported.ra, "A", "the first nested Widget mixin expanded and ran")
    t.equal(imported.rb, "B", "the second same-named nested Widget mixin also expanded from its own declaration")
})

// M5 — a nested `@mixin` shadowing a top-level one of the same name. The nested consumer's
// generated `$base extends M` references `M` by name, which resolves lexically to the nested
// mixin, so the consumer gets the nested member — while the top-level mixin keeps its own.
it("resolves a nested mixin that shadows a top-level name", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { mixin } from "ts-mixin-class"

        @mixin()
        class M {
            top (): string { return "top" }
        }

        function f (): string {
            @mixin()
            class M {
                nested (): string { return "nested" }
            }

            class U implements M {}

            return new U().nested()
        }

        class TopConsumer implements M {}

        export const fromNested = f()
        export const fromTop = new TopConsumer().top()
    `)

    t.equal(imported.fromNested, "nested", "the nested consumer resolved the shadowing nested mixin")
    t.equal(imported.fromTop, "top", "the top-level consumer still resolves the top-level mixin")
})

// M5b — a PLAIN (undecorated) nested class whose name collides with a `@mixin` in a SIBLING
// scope. The consumer next to the plain class implements it as ordinary TypeScript (providing
// the members itself) — its lexical `Widget` is NOT a mixin, so the consumer must NOT expand:
// mixin resolution is by the nearest enclosing-scope declaration, not by a flat file-wide
// name lookup (which would find the sibling scope's mixin and splice runtime machinery that
// references the plain class — an artifact TS2322 `RuntimeMixinClassValue` on the emit plane;
// found by stress seed 1119868945). The mixin's own scope keeps expanding.
it("does not expand a consumer whose lexical target is a plain class shadowing a sibling-scope mixin name", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { mixin } from "ts-mixin-class"

        function buildPlain (): string {
            class Widget {
                w (): string { return "plain" }
            }

            class UsePlain implements Widget {
                w (): string { return new Widget().w() }
            }

            return new UsePlain().w()
        }

        function buildMixed (): string {
            @mixin()
            class Widget {
                w (): string { return "mixed" }
            }

            class UseMixed implements Widget {}

            return new UseMixed().w()
        }

        export const fromPlain = buildPlain()
        export const fromMixed = buildMixed()
    `)

    t.equal(imported.fromPlain, "plain", "the plain-class scope stays ordinary TypeScript and runs")
    t.equal(imported.fromMixed, "mixed", "the sibling mixin scope still expands its consumer")
})

// M6 — a `@mixin` / consumer written as a class EXPRESSION (anonymous or named) has no stable
// statement slot for the generated siblings, so it is rejected with a clean native diagnostic
// rather than a bare TS2420. A named class DECLARATION (the supported form) is never flagged.
it("flags a mixin / consumer class expression with a native diagnostic", async (t: Test) => {
    const codesFor = (body: string): number[] => {
        const native: NativeMixinDiagnostic[] = []

        transformSourceFile(
            ts,
            createSourceFile(`
                import { mixin } from "ts-mixin-class"

                @mixin()
                class M {
                    a (): string { return "x" }
                }

                ${body}
            `),
            {},
            undefined,
            native
        )

        return native.map((diagnostic) => diagnostic.code)
    }

    t.eq(
        codesFor("const C = class implements M {}\nvoid C"),
        [ 990003 ],
        "a consumer class expression is flagged TS990003"
    )
    t.eq(
        codesFor("function f () { const C = class implements M {}; return C }\nvoid f"),
        [ 990003 ],
        "a nested consumer class expression is flagged TS990003"
    )
    t.eq(
        codesFor("const D = @mixin() class { b (): string { return \"y\" } }\nvoid D"),
        [ 990002 ],
        "a `@mixin` class expression is flagged TS990002"
    )
    t.eq(
        codesFor("class Good implements M {}\nvoid Good"),
        [],
        "a named class declaration consumer (the supported form) is never flagged"
    )
    t.eq(
        codesFor("const G = class { z (): number { return 1 } }\nvoid G"),
        [],
        "a plain class expression that touches no mixin is never flagged"
    )
})

// M7 — a nested CONSTRUCTION class (extends the package `Base`) expands inside a function: it
// gets its generated static `.new(...)` factory and its `<Name>Config` alias placed in the same
// block, and constructs correctly at runtime through the inherited `Base.new`.
it("expands a nested construction class (.new + config) and constructs at runtime", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { Base } from "ts-mixin-class/base"

        function build (): { x: number, y: number } {
            class Point extends Base {
                public x!: number = 0
                public y!: number = 0
            }

            return Point.new({ x: 3, y: 4 })
        }

        export const point = build()
    `)

    t.eq(imported.point, { x: 3, y: 4 }, "the nested construction class built through its generated .new(...)")
})

// M10 — nested classes are locals, so they (and their generated siblings) never leak into the
// emitted `.d.ts`. Only the file's real top-level exports appear.
it("keeps nested classes and their generated siblings out of the .d.ts", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { declaration: true },
        sourceFiles            : [ { fileName : "source.ts", text     : `
            import { mixin } from "ts-mixin-class"

            @mixin()
            class Tagger {
                tag (value: string): string { return value }
            }

            export function build (): string {
                @mixin()
                class LocalMixin {
                    hi (): string { return "hi" }
                }

                class LocalConsumer implements LocalMixin, Tagger {}

                return new LocalConsumer().hi()
            }

            // The instance of a nested class escapes through an INFERRED return type. TypeScript
            // widens the un-nameable local type to its structural shape in the .d.ts, so the
            // member surface appears but neither the nested class name nor the generated \`$base\`
            // name leaks.
            export function makeTagger () {
                class Escaping implements Tagger {}

                return new Escaping()
            }
        ` } ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.equal(result.exitCode, 0, `Builds with declarations.\n${commandOutput(result)}`)

        const declaration = await readFile(path.join(fixture.directory, "dist", "source.d.ts"), "utf8")

        t.match(declaration, "export declare function build", "the real top-level export is declared")
        t.notMatch(declaration, "LocalMixin", "the nested mixin does not leak into the .d.ts")
        t.notMatch(declaration, "LocalConsumer", "the nested consumer does not leak into the .d.ts")
        t.notMatch(declaration, "$base", "no generated nested sibling leaks into the .d.ts")

        // An escaping nested instance widens to its structural shape — the member surface is
        // emitted, but no nested-class or generated name appears.
        t.match(declaration, "tag(value: string): string", "an escaped nested type widens to its structural surface")
        t.notMatch(declaration, "Escaping", "the escaping nested class name never leaks")
    } finally {
        await fixture.dispose()
    }
})

// M12 — a consumer (or mixin) declared directly in a `switch` CASE CLAUSE. A case clause owns a
// statement list that is NOT a `Block`, so the splice must handle `CaseClause`/`DefaultClause`
// statement lists too — otherwise the class is indexed as nested but silently never expanded
// (the user sees a bare TS2420 with no hint).
it("expands a consumer declared in a switch case clause (emit + runtime)", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Tagger {
            tag (value: string): string { return "[" + value + "]" }
        }

        function pick (kind: number): string {
            switch (kind) {
                case 1:
                    class CaseConsumer implements Tagger {}
                    return new CaseConsumer().tag("case")
                default: {
                    @mixin()
                    class DefaultMixin {
                        d (): string { return "default" }
                    }

                    class DefaultConsumer implements DefaultMixin {}

                    return new DefaultConsumer().d()
                }
            }
        }

        export const fromCase = pick(1)
        export const fromDefault = pick(0)
    `)

    t.equal(imported.fromCase, "[case]", "the case-clause consumer expanded and ran")
    t.equal(imported.fromDefault, "default", "the default-clause (braced) nested mixin/consumer also ran")
})

// M12b — the generated siblings land inside the case clause's own statement list, not the
// enclosing function/module scope.
it("emits case-clause generated siblings into the clause statement list", async (t: Test) => {
    const transformed = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Tagger {
            tag (value: string): string { return value }
        }

        function pick (kind: number) {
            switch (kind) {
                case 1:
                    class CaseConsumer implements Tagger {}
                    return new CaseConsumer()
                default:
                    return undefined
            }
        }
        void pick
    `))

    const topLevelClassNames = transformed.statements
        .filter(ts.isClassDeclaration)
        .map((declaration) => declaration.name?.text)

    t.notOk(
        topLevelClassNames.includes("__CaseConsumer$base"),
        "the generated base does not leak into module-level statements"
    )

    const pick            = transformed.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === "pick"
    )
    const switchStatement = pick?.body?.statements.find(ts.isSwitchStatement)
    const caseClause      = switchStatement?.caseBlock.clauses.find(ts.isCaseClause)

    const clauseStatements: readonly ts.Statement[] = caseClause?.statements ?? []
    const clauseClassNames                          = clauseStatements
        .filter(ts.isClassDeclaration)
        .map((declaration) => declaration.name?.text)

    t.ok(
        clauseClassNames.includes("__CaseConsumer$base"),
        "the generated intermediate base is emitted inside the case clause"
    )
    t.ok(
        clauseClassNames.includes("CaseConsumer"),
        "the rewritten consumer stays inside the case clause"
    )
})

// M13 — the remaining container kinds a class declaration is legal in: a class METHOD body, an
// ARROW function body, a GETTER body, and a NAMESPACE (ModuleBlock). All expand like a function
// body. One build covers all four.
it("expands nested declarations in method / arrow / getter bodies and namespaces (emit + runtime)", async (t: Test) => {
    const imported = await buildAndImport(t, `
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Tagger {
            tag (value: string): string { return "[" + value + "]" }
        }

        class Host {
            fromMethod (): string {
                class MethodConsumer implements Tagger {}

                return new MethodConsumer().tag("method")
            }

            get viaGetter (): string {
                class GetterConsumer implements Tagger {}

                return new GetterConsumer().tag("getter")
            }
        }

        const fromArrow = (): string => {
            @mixin()
            class ArrowMixin {
                a (): string { return "arrow" }
            }

            class ArrowConsumer implements ArrowMixin {}

            return new ArrowConsumer().a()
        }

        namespace ns {
            @mixin()
            export class NsMixin {
                n (): string { return "namespace" }
            }

            export class NsConsumer implements NsMixin {}
        }

        export const method = new Host().fromMethod()
        export const getter = new Host().viaGetter
        export const arrow = fromArrow()
        export const namespaced = new ns.NsConsumer().n()
    `)

    t.equal(imported.method, "[method]", "a consumer in a class method body expanded")
    t.equal(imported.getter, "[getter]", "a consumer in a getter body expanded")
    t.equal(imported.arrow, "arrow", "a mixin + consumer in an arrow function body expanded")
    t.equal(imported.namespaced, "namespace", "a mixin + consumer in a namespace (ModuleBlock) expanded")
})
