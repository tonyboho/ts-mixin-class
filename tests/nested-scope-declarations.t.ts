import path from "node:path"
import { pathToFileURL } from "node:url"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { transformSourceFile } from "../src/index.js"
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

    t.notOk(topLevelClassNames.includes("__LocalConsumer$base"),
        "the generated base does not leak into module-level statements")
    t.notOk(topLevelClassNames.includes("LocalConsumer"),
        "the nested consumer itself stays nested, not hoisted to module scope")

    const build = transformed.statements.find(
        (statement): statement is ts.FunctionDeclaration =>
            ts.isFunctionDeclaration(statement) && statement.name?.text === "build"
    )

    const blockStatements: readonly ts.Statement[] = build?.body?.statements ?? []
    const blockClassNames                          = blockStatements
        .filter(ts.isClassDeclaration)
        .map((declaration) => declaration.name?.text)

    t.ok(blockClassNames.includes("__LocalConsumer$base"),
        "the generated intermediate base is emitted inside the function block")
    t.ok(blockClassNames.includes("LocalConsumer"),
        "the rewritten consumer stays inside the function block")
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
