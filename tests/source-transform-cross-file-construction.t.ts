import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

// Construction-base detection resolves the base chain across files through the
// cross-file registry: for ordinary classes extending an imported Base descendant,
// for consumers of an imported mixin whose required base is a Base descendant, and
// for consumers of an imported mixin that extends the package `Base` directly.

const providerText = `
    import { Base, type Config } from "ts-mixin-class/base"
    import { mixin } from "ts-mixin-class"

    export class AppBase extends Base {
        public appValue: string = "app"
    }

    @mixin()
    export class FeatureMixin extends AppBase {
        featureMethod(): string {
            return this.appValue
        }
    }

    @mixin()
    export class DirectBaseMixin extends Base {
        public mixinValue: number = 0
        public tag: string = ""

        override initialize(config?: Config<this>): void {
            super.initialize(config)

            this.tag = "init:" + this.mixinValue
        }
    }
`

it("regenerates construction members for an ordinary class extending an imported Base descendant", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "./provider.js"

                    class OrdinaryDerived extends AppBase {
                        public ownValue: number = 0
                    }

                    const instance = OrdinaryDerived.new({ appValue : "configured", ownValue : 7 })

                    const a: string = instance.appValue
                    const b: number = instance.ownValue

                    void [ a, b ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(result.exitCode, 0,
            `Ordinary cross-file Base descendant typechecks its regenerated new():\n${commandOutput(result)}`)
    } finally {
        await fixture.dispose()
    }
})

it("regenerates construction members for a consumer of an imported Base-descendant mixin", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { FeatureMixin } from "./provider.js"

                    class FeatureConsumer implements FeatureMixin {
                        public ownFlag: boolean = false
                    }

                    const instance = FeatureConsumer.new({ appValue : "configured", ownFlag : true })

                    const a: string = instance.appValue
                    const b: boolean = instance.ownFlag
                    const c: string = instance.featureMethod()

                    void [ a, b, c ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(result.exitCode, 0,
            `Consumer of a cross-file Base-descendant mixin typechecks its new():\n${commandOutput(result)}`)
    } finally {
        await fixture.dispose()
    }
})

it("supports a consumer of an imported mixin that extends Base directly, including its initialize override", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { DirectBaseMixin } from "./provider.js"

                    class DirectConsumer implements DirectBaseMixin {
                        public ownFlag: boolean = false
                    }

                    const instance = DirectConsumer.new({ mixinValue : 7, tag : "", ownFlag : true })

                    const a: number = instance.mixinValue
                    const b: boolean = instance.ownFlag

                    console.log("RESULT:" + JSON.stringify({ a, b, tag : instance.tag }))
                `
            }
        ]
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(build.exitCode, 0,
            `Consumer of a mixin that extends Base directly typechecks and emits:\n${commandOutput(build)}`)

        const run = await runCommand("node", [ path.join(fixture.directory, "dist", "consumer.js") ], fixture.directory)

        t.isStrict(run.exitCode, 0, `Emitted consumer runs:\n${commandOutput(run)}`)
        t.match(run.stdout, `RESULT:${JSON.stringify({ a : 7, b : true, tag : "init:7" })}`,
            "The mixin's initialize override (which calls super.initialize on Base) runs for the consumer")
    } finally {
        await fixture.dispose()
    }
})
