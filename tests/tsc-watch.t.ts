import { writeFile } from "node:fs/promises"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, requiredFixtureSourceFile } from "./util.js"
import { errorCount, startTscWatch } from "./tsc-watch-util.js"

// End-to-end watch-mode test: drive a REAL `tsc --watch` process over a fixture (not an
// in-process program like `stress-edit`) and assert diagnostics stay correct across rebuilds.
//
// What it pins: under watch, TypeScript rebuilds the program incrementally on each file change.
// The program transform must be re-invoked on every rebuild AND its per-program caches (facts,
// registry, import maps) must invalidate for the changed file — otherwise a cross-file mixin
// edit would serve a STALE injected interface and the consumer would keep type-checking against
// members that no longer exist. The round-trip (break -> rebuild -> revert -> rebuild) proves
// both the staleness (the break must surface) and the recovery (the revert must clear).
//
// The watch process (the package's own patched `tsc`, launched with `-w`) is driven through
// `tsc-watch-util`; this file owns only the cross-file-mixin scenario.

// A `@mixin` exposing one method; the method name is parameterized so we can rename it under
// watch to break (and then restore) the consumer that calls it.
const greeterMixin = (methodName: string): string => `
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class Greeter {
        ${methodName}(): string {
            return "hello"
        }
    }
`

const greeterConsumer = `
    import { Greeter } from "./mixin.js"

    class Consumer implements Greeter {
    }

    const consumer = new Consumer()

    void consumer.greet()
`

it("reports and clears a cross-file mixin error across tsc --watch rebuilds", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { noEmit: true },
        sourceFiles            : [
            { fileName: "mixin.ts", text: greeterMixin("greet") },
            { fileName: "consumer.ts", text: greeterConsumer }
        ]
    })

    const mixinFile = requiredFixtureSourceFile(fixture.sourceFiles, "mixin.ts")
    const watch     = startTscWatch(fixture.directory, fixture.tsconfigFile)

    try {
        const initial = await watch.waitForBuild()

        t.is(errorCount(initial), 0, "Initial watch build is clean — the transform injected the mixin's `greet` into the consumer")

        // Break it: rename the mixin method. The consumer's `consumer.greet()` only type-checks
        // because the transform injects `greet` into the consumer's interface; after the rename a
        // re-invoked, cache-invalidated transform must drop `greet`, so the call must now error.
        await writeFile(mixinFile, greeterMixin("greetRenamed"))

        const afterBreak = await watch.waitForBuild()

        t.is(errorCount(afterBreak), 1, "Renaming the mixin method surfaces exactly one error on the next rebuild")
        t.match(afterBreak, "consumer.ts", "The error lands in the consumer that calls the renamed member")
        t.match(afterBreak, "greet", "The diagnostic names the now-missing `greet` member")

        // Recover: restore the method. A re-invoked transform must re-inject `greet`, clearing the
        // error — proving the rebuild re-applied the transform rather than serving a stale program.
        await writeFile(mixinFile, greeterMixin("greet"))

        const afterRevert = await watch.waitForBuild()

        t.is(errorCount(afterRevert), 0, "Reverting the mixin restores a clean watch build")
    } finally {
        watch.dispose()
        await fixture.dispose()
    }
})

const topologyMixins = (greeterDecorator: boolean, farewellDecorator: boolean): string => `
    import { mixin } from "ts-mixin-class"

    ${greeterDecorator ? "@mixin()" : ""}
    export class Greeter {
        greet(): string { return "hello" }
    }

    ${farewellDecorator ? "@mixin()" : ""}
    export class Farewell {
        bye(): string { return "bye" }
    }
`

const topologyConsumer = (specifier: "./mixins.js" | "./barrel.js", mixinName: "Greeter" | "Farewell"): string => `
    import { ${mixinName} } from "${specifier}"

    class Consumer implements ${mixinName} {
    }

    const consumer = new Consumer()

    void consumer.${mixinName === "Greeter" ? "greet" : "bye"}()
`

it("invalidates registry topology when decorators, implements targets and barrels change under watch", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { noEmit: true },
        sourceFiles            : [
            { fileName: "mixins.ts", text: topologyMixins(true, true) },
            { fileName: "barrel.ts", text: `export { Greeter, Farewell } from "./mixins.js"` },
            { fileName: "consumer.ts", text: topologyConsumer("./mixins.js", "Greeter") }
        ]
    })

    const mixinsFile   = requiredFixtureSourceFile(fixture.sourceFiles, "mixins.ts")
    const consumerFile = requiredFixtureSourceFile(fixture.sourceFiles, "consumer.ts")
    const watch        = startTscWatch(fixture.directory, fixture.tsconfigFile)

    try {
        t.is(errorCount(await watch.waitForBuild()), 0, "initial direct-import Greeter topology is clean")

        await writeFile(mixinsFile, topologyMixins(false, true))
        t.true(errorCount(await watch.waitForBuild()) > 0, "removing @mixin invalidates the registry and breaks its consumer")

        await writeFile(mixinsFile, topologyMixins(true, true))
        t.is(errorCount(await watch.waitForBuild()), 0, "restoring @mixin restores the transformed consumer")

        await writeFile(consumerFile, topologyConsumer("./mixins.js", "Farewell"))
        t.is(errorCount(await watch.waitForBuild()), 0, "changing the implements target rebuilds against the other mixin")

        await writeFile(consumerFile, topologyConsumer("./barrel.js", "Farewell"))
        t.is(errorCount(await watch.waitForBuild()), 0, "switching a direct import to a barrel keeps the mixin resolved")

        await writeFile(mixinsFile, topologyMixins(true, false))
        t.true(errorCount(await watch.waitForBuild()) > 0, "the barrel route also observes mixin removal")

        await writeFile(mixinsFile, topologyMixins(true, true))
        t.is(errorCount(await watch.waitForBuild()), 0, "the complete topology recovers without restarting watch")
    } finally {
        watch.dispose()
        await fixture.dispose()
    }
})

type ConstructionMixinShape = {
    construction : boolean,
    extra        : boolean,
    scoreType    : "number" | "number | string",
    titleType    : "number" | "string"
}

const constructionMixin = ({ construction, extra, scoreType, titleType }: ConstructionMixinShape): string => `
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    export class Configured ${construction ? "extends Base" : ""} {
        public title!: ${titleType} = ${titleType === "string" ? '""' : "0"}
        ${extra ? "public extra!: boolean = false" : ""}

        private scoreValue: number = 0

        public get score(): number {
            return this.scoreValue
        }

        public set score(value: ${scoreType}) {
            this.scoreValue = Number(value)
        }
    }
`

const constructionConsumer = (title: "1" | '"title"', score: "1" | '"1"', extra: boolean): string => `
    import { Configured } from "./configured.js"

    class Model implements Configured {
        public own!: Date = new Date(0)
    }

    const model = Model.new({
        title : ${title},
        score : ${score},
        ${extra ? "extra : true," : ""}
        own   : new Date(0)
    })

    const titleValue: ${title === "1" ? "number" : "string"} = model.title
    const scoreValue: number = model.score

    void [ titleValue, scoreValue ]
`

it("invalidates construction config shape and construction opt-in across diverse watch edits", async (t: Test) => {
    const initialShape: ConstructionMixinShape = {
        construction : true,
        extra        : false,
        scoreType    : "number | string",
        titleType    : "string"
    }
    const fixture                              = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { noEmit: true },
        sourceFiles            : [
            { fileName: "configured.ts", text: constructionMixin(initialShape) },
            { fileName: "consumer.ts", text: constructionConsumer('"title"', '"1"', false) }
        ]
    })

    const configuredFile = requiredFixtureSourceFile(fixture.sourceFiles, "configured.ts")
    const consumerFile   = requiredFixtureSourceFile(fixture.sourceFiles, "consumer.ts")
    const watch          = startTscWatch(fixture.directory, fixture.tsconfigFile)

    try {
        t.is(errorCount(await watch.waitForBuild()), 0, "initial construction config is clean")

        await writeFile(configuredFile, constructionMixin({ ...initialShape, scoreType: "number" }))
        t.true(errorCount(await watch.waitForBuild()) > 0, "narrowing an imported setter type invalidates the consumer config")

        await writeFile(configuredFile, constructionMixin(initialShape))
        t.is(errorCount(await watch.waitForBuild()), 0, "restoring the setter type clears the config error")

        await writeFile(configuredFile, constructionMixin({ ...initialShape, extra: true }))
        t.true(errorCount(await watch.waitForBuild()) > 0, "adding a required imported config field invalidates the consumer")

        await writeFile(consumerFile, constructionConsumer('"title"', '"1"', true))
        t.is(errorCount(await watch.waitForBuild()), 0, "supplying the new required field recovers without restarting watch")

        await writeFile(configuredFile, constructionMixin({ ...initialShape, extra: true, titleType: "number" }))
        t.true(errorCount(await watch.waitForBuild()) > 0, "changing an existing config field type invalidates the cached shape")

        await writeFile(consumerFile, constructionConsumer("1", '"1"', true))
        t.is(errorCount(await watch.waitForBuild()), 0, "updating the consumer to the new field type recovers")

        await writeFile(configuredFile, constructionMixin({
            construction : false,
            extra        : true,
            scoreType    : "number | string",
            titleType    : "number"
        }))
        t.true(errorCount(await watch.waitForBuild()) > 0, "removing the Base ancestry removes the consumer's generated .new")

        await writeFile(configuredFile, constructionMixin({ ...initialShape, extra: true, titleType: "number" }))
        t.is(errorCount(await watch.waitForBuild()), 0, "restoring construction ancestry restores .new and its accumulated config")

        await writeFile(configuredFile, constructionMixin(initialShape))
        await writeFile(consumerFile, constructionConsumer('"title"', '"1"', false))
        t.is(errorCount(await watch.waitForBuild()), 0, "the complete construction edit sequence returns to its initial state")
    } finally {
        watch.dispose()
        await fixture.dispose()
    }
})

const requiredBaseClasses = (actualExtendsRoot: boolean): string => `
    export class Root {
        root: string = "root"
    }

    export class Other {
        other: string = "other"
    }

    export class Actual ${actualExtendsRoot ? "extends Root" : ""} {
        actual: string = "actual"
    }
`

const requiredBaseMixin = (base: "Other" | "Root"): string => `
    import { mixin } from "ts-mixin-class"
    import { ${base} } from "./bases.js"

    @mixin()
    export class NeedsBase extends ${base} {
        feature(): string {
            return "feature"
        }
    }
`

const requiredBaseConsumer = (base: "Actual" | "Other"): string => `
    import { ${base} } from "./bases.js"
    import { NeedsBase } from "./needs-base.js"

    class Consumer extends ${base} implements NeedsBase {
    }

    const consumer = new Consumer()
    const feature: string = consumer.feature()

    void feature
`

it("invalidates required-base ancestry and mixin constraints under watch", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { noEmit: true },
        sourceFiles            : [
            { fileName: "bases.ts", text: requiredBaseClasses(true) },
            { fileName: "needs-base.ts", text: requiredBaseMixin("Root") },
            { fileName: "consumer.ts", text: requiredBaseConsumer("Actual") }
        ]
    })

    const basesFile    = requiredFixtureSourceFile(fixture.sourceFiles, "bases.ts")
    const mixinFile    = requiredFixtureSourceFile(fixture.sourceFiles, "needs-base.ts")
    const consumerFile = requiredFixtureSourceFile(fixture.sourceFiles, "consumer.ts")
    const watch        = startTscWatch(fixture.directory, fixture.tsconfigFile)

    try {
        t.is(errorCount(await watch.waitForBuild()), 0, "initial nominal required-base ancestry is clean")

        await writeFile(basesFile, requiredBaseClasses(false))
        t.true(errorCount(await watch.waitForBuild()) > 0, "removing the consumer base's Root ancestry invalidates required-base relations")

        await writeFile(basesFile, requiredBaseClasses(true))
        t.is(errorCount(await watch.waitForBuild()), 0, "restoring nominal ancestry clears the required-base error")

        await writeFile(mixinFile, requiredBaseMixin("Other"))
        t.true(errorCount(await watch.waitForBuild()) > 0, "changing the mixin's own required base invalidates consumers")

        await writeFile(consumerFile, requiredBaseConsumer("Other"))
        t.is(errorCount(await watch.waitForBuild()), 0, "moving the consumer to the new required base recovers")

        await writeFile(mixinFile, requiredBaseMixin("Root"))
        t.true(errorCount(await watch.waitForBuild()) > 0, "changing the requirement back is observed against the still-Other consumer")

        await writeFile(consumerFile, requiredBaseConsumer("Actual"))
        t.is(errorCount(await watch.waitForBuild()), 0, "the required-base topology returns to its initial clean state")
    } finally {
        watch.dispose()
        await fixture.dispose()
    }
})
