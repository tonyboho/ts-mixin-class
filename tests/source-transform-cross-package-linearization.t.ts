import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, requiredFixtureSourceFile, runCommand } from "./util.js"
import type { TypeScriptFixtureSourceFile } from "./util.js"
import { assertResponseBody, runTypeScriptServerRequest } from "./tsserver-util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

type SemanticDiagnostic = {
    text?    : string,
    message? : string
}

// Builds a library through the transformer (emit + declarations) and re-roots its
// emitted `dist` under `node_modules/<packageName>/` so a separate program consumes it
// as a published package -- through generated `.d.ts` only, never the source. Unlike the
// construction-test variant this accepts `dependencyPackages`: the declaration output of
// packages this library itself depends on, written to disk (but not compiled) so the
// library's own build can resolve its cross-package imports.
async function buildDeclarationPackage(
    t: Test,
    packageName: string,
    libraryFiles: TypeScriptFixtureSourceFile[],
    dependencyPackages: TypeScriptFixtureSourceFile[] = []
): Promise<TypeScriptFixtureSourceFile[]> {
    const library = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : libraryFiles,
        extraFiles             : dependencyPackages
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", library.tsconfigFile ], library.directory)

        t.isStrict(build.exitCode, 0, `Package "${packageName}" compiles on its own:\n${commandOutput(build)}`)

        const distDirectory = path.join(library.directory, "dist")
        const emittedNames  = await readdir(distDirectory)
        const emitted       = await Promise.all(emittedNames.map(async (name) => ({
            fileName : `node_modules/${packageName}/${name}`,
            text     : await readFile(path.join(distDirectory, name), "utf8")
        })))

        const exportsMap: Record<string, { types: string, default: string }> = {}

        for (const name of emittedNames) {
            if (name.endsWith(".js")) {
                const stem = name.slice(0, -3)

                exportsMap[`./${stem}`] = { types: `./${stem}.d.ts`, default: `./${stem}.js` }
            }
        }

        return [
            {
                fileName : `node_modules/${packageName}/package.json`,
                text     : JSON.stringify({
                    name    : packageName,
                    version : "0.0.0",
                    type    : "module",
                    exports : exportsMap
                }, null, 4)
            },
            ...emitted
        ]
    } finally {
        await library.dispose()
    }
}

// The single-file linearization conflict (tsserver-diagnostics.t.ts) split across four
// packages, the way real code would hit it:
//
//   package "linearization-ab": leaf mixins A and B
//   package "linearization-x":  X implements [A, B]   (order A before B)
//   package "linearization-y":  Y implements [B, A]   (order B before A)
//   the consumer program:       a mixin implements [X, Y] -> A and B are forced into
//                               opposite orders -> no consistent C3 linearization.
//
// Each of the three packages compiles cleanly on its own (asserted by
// buildDeclarationPackage). Only their composition is inconsistent, and it must be
// reported as a compile error -- in BOTH the `tsc` (emit) and the tsserver (source-view)
// paths -- exactly as the single-file case is, with the dependency graph recovered from
// the published `.d.ts` declarations across package boundaries.
it("reports a cross-package C3 linearization conflict in both tsc and tsserver", async (t: Test) => {
    const abPackage = await buildDeclarationPackage(t, "linearization-ab", [
        {
            fileName : "ab.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                @mixin()
                export class LinearizationA {
                    a(): string {
                        return "a"
                    }
                }

                @mixin()
                export class LinearizationB {
                    b(): string {
                        return "b"
                    }
                }
            `
        }
    ])

    const xPackage = await buildDeclarationPackage(t, "linearization-x", [
        {
            fileName : "x.ts",
            text     : `
                import { mixin } from "ts-mixin-class"
                import { LinearizationA, LinearizationB } from "linearization-ab/ab"

                @mixin()
                export class LinearizationX implements LinearizationA, LinearizationB {
                    a(): string {
                        return "a"
                    }

                    b(): string {
                        return "b"
                    }
                }
            `
        }
    ], abPackage)

    const yPackage = await buildDeclarationPackage(t, "linearization-y", [
        {
            fileName : "y.ts",
            text     : `
                import { mixin } from "ts-mixin-class"
                import { LinearizationA, LinearizationB } from "linearization-ab/ab"

                @mixin()
                export class LinearizationY implements LinearizationB, LinearizationA {
                    a(): string {
                        return "a"
                    }

                    b(): string {
                        return "b"
                    }
                }
            `
        }
    ], abPackage)

    const consumerText = `
        import { mixin } from "ts-mixin-class"
        import { LinearizationX } from "linearization-x/x"
        import { LinearizationY } from "linearization-y/y"

        @mixin()
        export class BadLinearizationMixin implements LinearizationX, LinearizationY {
            a(): string {
                return "a"
            }

            b(): string {
                return "b"
            }
        }

        export class BadLinearizationConsumer implements BadLinearizationMixin {
        }
    `

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : [ ...abPackage, ...xPackage, ...yPackage ],
        sourceFiles            : [ { fileName: "consumer.ts", text: consumerText } ]
    })

    try {
        // tsc (emit path): the conflict must fail the build with the C3 diagnostic.
        const build  = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)
        const output = commandOutput(build)

        t.ne(build.exitCode, 0,
            `Composing conflicting cross-package mixins must fail to compile (tsc):\n${output}`)
        t.match(output, "Cannot linearize mixin classes with the C3 algorithm",
            `tsc reports the cross-package C3 conflict:\n${output}`)
        t.match(output, "LinearizationA", `tsc names the conflicting dependency LinearizationA:\n${output}`)
        t.match(output, "LinearizationB", `tsc names the conflicting dependency LinearizationB:\n${output}`)

        // tsserver (source-view path): the same conflict must surface for the IDE.
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "consumer.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                consumerText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        t.match(messages, "Cannot linearize mixin classes with the C3 algorithm",
            `tsserver reports the cross-package C3 conflict:\n${messages}`)
        t.match(messages, "LinearizationA", `tsserver names the conflicting dependency LinearizationA:\n${messages}`)
        t.match(messages, "LinearizationB", `tsserver names the conflicting dependency LinearizationB:\n${messages}`)
    } finally {
        await fixture.dispose()
    }
})
