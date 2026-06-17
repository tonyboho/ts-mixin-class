import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { assertSuccessfulCommand, commandOutput, createTypeScriptFixture, packageRoot, runCommand, runPnpm } from "./util.js"

const fixtureSuiteDirectory = path.join(packageRoot, "tests", "fixture-suite")
const installResult         = await runPnpm(fixtureSuiteDirectory, "install")

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
