import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, commandOutput, createTypeScriptFixture, packageRoot, runCommand, runPnpm } from "./util.js"

// The fixture-suite-building integration tests live together in ONE file on purpose: they
// all clean+rebuild the SHARED `tests/fixture-suite` build output in place, and siesta runs
// `it` blocks within a file sequentially (one worker) — so they never race. (Split across
// files, one test's `clean:standard` wiped another's just-built `dist/standard` mid-read.)
const fixtureSuiteDirectory     = path.join(packageRoot, "tests", "fixture-suite")
const declarationFixtureDirectory = path.join(packageRoot, "tests", "declaration-fixture-suite")
const installResult            = await runPnpm(fixtureSuiteDirectory, "install")
const declarationInstallResult = await runPnpm(declarationFixtureDirectory, "install")

it("builds and runs the fixture suite with standard decorators", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "clean:standard"),
        "Clean fixture suite standard build output"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build:standard"),
        "Build fixture suite with standard decorators"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test:standard"),
        "Run fixture suite with standard decorators"
    )
})

it("builds and runs the fixture suite with legacy decorators", async (t: Test) => {
    assertSuccessfulCommand(t, installResult, "Install fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "clean:legacy"),
        "Clean fixture suite legacy build output"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build:legacy"),
        "Build fixture suite with legacy decorators"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "test:legacy"),
        "Run fixture suite with legacy decorators"
    )
})

it("reports imported declaration mixins without runtime values", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles            : [
            {
                fileName : "node_modules/broken-mixin-package/package.json",
                text     : JSON.stringify({
                    name    : "broken-mixin-package",
                    type    : "module",
                    exports : {
                        "." : {
                            types : "./index.d.ts"
                        }
                    }
                }, null, 4)
            }
        ],
        sourceFiles            : [
            {
                fileName : "node_modules/broken-mixin-package/index.d.ts",
                text     : `
                    import type { RuntimeMixinClass } from "ts-mixin-class"

                    export interface BrokenMixin {
                        brokenMethod(): string
                    }

                    export declare const BrokenMixin: RuntimeMixinClass & {
                        new (...args: any[]): BrokenMixin
                    }
                `
            },
            {
                fileName : "consumer.ts",
                text     : `
                    import type { BrokenMixin } from "broken-mixin-package"

                    class Consumer implements BrokenMixin {
                    }

                    void Consumer
                `
            }
        ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const output = commandOutput(result)

        t.not.isStrict(result.exitCode, 0, "Broken declaration-only mixin package fails to build")
        t.match(output, "Missing mixin runtime value", "Reports missing runtime value")
        t.match(output, "BrokenMixin", "Diagnostic names the broken mixin")
        t.match(output, "broken-mixin-package", "Diagnostic names the package")
    } finally {
        await fixture.dispose()
    }
})

it("builds and runs the declaration fixture suite", async (t: Test) => {
    assertSuccessfulCommand(t, declarationInstallResult, "Install declaration fixture suite dependencies")

    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "clean:standard"),
        "Clean fixture suite library package standard build output"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(fixtureSuiteDirectory, "run", "build:standard"),
        "Build fixture suite library package"
    )

    const mixinsDeclaration = await readFile(
        path.join(fixtureSuiteDirectory, "dist", "standard", "mixins.d.ts"),
        "utf8"
    )
    const defaultMixinDeclaration = await readFile(
        path.join(fixtureSuiteDirectory, "dist", "standard", "default-mixin.d.ts"),
        "utf8"
    )

    t.match(mixinsDeclaration, "export declare const __SourceClass1$mixin", "Named mixin factory is exported for downstream generated imports")
    t.match(mixinsDeclaration, "export declare const SourceClass1", "Named mixin runtime value is exported")

    // Lock both value-cast forms in the emitted declarations: non-generic mixins
    // use the factored MixinClassValue alias (with the required base as the third
    // argument when present); generic mixins keep the inline constructor cast.
    t.match(
        mixinsDeclaration,
        "export declare const ContractMixin: MixinClassValue<ContractMixin, typeof __ContractMixin$mixin> & RuntimeMixinClass;",
        "Non-generic mixin value uses the factored MixinClassValue alias"
    )
    t.match(
        mixinsDeclaration,
        "export declare const RequiredMixin: MixinClassValue<RequiredMixin, typeof __RequiredMixin$mixin, RequiredBase> & RuntimeMixinClass<RequiredBase>;",
        "Non-generic required-base mixin keeps the required base in MixinClassValue and RuntimeMixinClass"
    )
    t.match(
        mixinsDeclaration,
        "export declare const SourceClass1: (new <A1>(...args: any[]) => SourceClass1<A1>) &",
        "Generic mixin keeps the inline constructor cast"
    )
    t.notMatch(
        mixinsDeclaration,
        "SourceClass1: MixinClassValue",
        "Generic mixin is not collapsed into the MixinClassValue alias"
    )
    t.match(defaultMixinDeclaration, "export declare const __DefaultMixin$mixin", "Default mixin factory is exported for downstream generated imports")
    t.match(defaultMixinDeclaration, "declare const DefaultMixin", "Default mixin runtime value is declared")
    t.match(defaultMixinDeclaration, "export default DefaultMixin", "Default mixin declaration preserves default export shape")
    t.notMatch(defaultMixinDeclaration, "export declare const DefaultMixin", "Default mixin value is not accidentally exported as a named value")

    assertSuccessfulCommand(
        t,
        await runPnpm(declarationFixtureDirectory, "run", "build"),
        "Build declaration fixture consumer"
    )
    assertSuccessfulCommand(
        t,
        await runPnpm(declarationFixtureDirectory, "run", "test"),
        "Run declaration fixture consumer"
    )
})
