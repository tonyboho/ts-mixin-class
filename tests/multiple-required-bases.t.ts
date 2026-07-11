import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

type BuildResults = {
    emit       : CommandResult,
    sourceView : CommandResult,
    runtime    : CommandResult | undefined
}

async function buildBoth(source: string | TypeScriptFixtureSourceFile[], run = false): Promise<BuildResults> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : typeof source === "string"
            ? [ { fileName: "source.ts", text: source } ]
            : source
    })

    try {
        const emit       = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceView = await runCommand(
            "node",
            [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ],
            fixture.directory
        )
        const runtime    = run && emit.exitCode === 0
            ? await runCommand("node", [ path.join("dist", "source.js") ], fixture.directory)
            : undefined

        return { emit, sourceView, runtime }
    } finally {
        await fixture.dispose()
    }
}

function assertBuildAndRuntime(t: Test, results: BuildResults): void {
    t.equal(results.emit.exitCode, 0, `emit succeeds.\n${commandOutput(results.emit)}`)
    t.equal(results.sourceView.exitCode, 0, `source view succeeds.\n${commandOutput(results.sourceView)}`)
    t.equal(results.runtime?.exitCode, 0, `runtime succeeds.\n${commandOutput(results.runtime!)}`)
}

function assertRequiredBaseConflict(t: Test, results: BuildResults, expectedNames: string[]): void {
    for (const [ plane, result ] of [
        [ "emit", results.emit ],
        [ "source view", results.sourceView ]
    ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: incompatible required bases are rejected`)
        t.match(output, "TS990013", `${plane}: reports the required-base conflict diagnostic.\n${output}`)
        t.match(output, "Incompatible mixin required bases", `${plane}: explains the conflict.\n${output}`)

        for (const name of expectedNames) {
            t.match(output, name, `${plane}: names ${name}.\n${output}`)
        }
    }
}

it("selects the most-specific required base independently of mixin order", async (t: Test) => {
    const results = await buildBoth(
        trimIndent(`
        import { mixin } from "ts-mixin-class"

        class RootBase {
            static rootStatic: string = "root"

            root(): string {
                return "root"
            }
        }

        class SpecificBase extends RootBase {
            static specificStatic: string = "specific"

            specific(): string {
                return "specific"
            }
        }

        @mixin()
        class NeedsRoot extends RootBase {
            fromRootMixin(): string {
                return this.root()
            }
        }

        @mixin()
        class NeedsSpecific extends SpecificBase {
            fromSpecificMixin(): string {
                return this.specific()
            }
        }

        class BroadFirst implements NeedsRoot, NeedsSpecific {
        }

        class SpecificFirst implements NeedsSpecific, NeedsRoot {
        }

        const broadFirst    = new BroadFirst()
        const specificFirst = new SpecificFirst()

        const staticA: string = BroadFirst.specificStatic
        const staticB: string = SpecificFirst.specificStatic

        for (const value of [ broadFirst, specificFirst ]) {
            if (!(value instanceof SpecificBase)) throw new Error("the most-specific base was not selected")
            if (!(value instanceof RootBase)) throw new Error("the base ancestry was not preserved")
            if (!(value instanceof NeedsRoot)) throw new Error("NeedsRoot was not applied")
            if (!(value instanceof NeedsSpecific)) throw new Error("NeedsSpecific was not applied")
            if (value.fromRootMixin() !== "root") throw new Error("the broad-base mixin is broken")
            if (value.fromSpecificMixin() !== "specific") throw new Error("the specific-base mixin is broken")
        }

        void [ staticA, staticB ]
    `),
        true
    )

    assertBuildAndRuntime(t, results)
})

it("selects the required base transitively for a mixin acting as a consumer", async (t: Test) => {
    const results = await buildBoth(
        trimIndent(`
        import { Empty, mixin } from "ts-mixin-class"

        class RootBase {
            root(): string {
                return "root"
            }
        }

        class SpecificBase extends RootBase {
            specific(): string {
                return "specific"
            }
        }

        @mixin()
        class NeedsRoot extends RootBase {
            rootMixin(): string {
                return this.root()
            }
        }

        @mixin()
        class NeedsSpecific extends SpecificBase {
            specificMixin(): string {
                return this.specific()
            }
        }

        @mixin()
        class Composite implements NeedsRoot, NeedsSpecific {
            composite(): string {
                return this.rootMixin() + this.specificMixin()
            }
        }

        @mixin()
        class Outer implements Composite {
            outer(): string {
                return this.composite()
            }
        }

        class Consumer implements Outer {
        }

        @mixin()
        class BaseLess {
        }

        class BaseLessConsumer implements BaseLess {
        }

        const composite = new Composite()
        const consumer  = new Consumer()
        const baseLess  = new BaseLessConsumer()

        if (!(composite instanceof SpecificBase)) throw new Error("Composite lost its transitive base")
        if (!(consumer instanceof SpecificBase)) throw new Error("Consumer lost its transitive base")
        if (!(consumer instanceof NeedsRoot)) throw new Error("transitive NeedsRoot was not applied")
        if (!(consumer instanceof NeedsSpecific)) throw new Error("transitive NeedsSpecific was not applied")
        if (!(consumer instanceof Composite)) throw new Error("Composite was not applied")
        if (!(consumer instanceof Outer)) throw new Error("Outer was not applied")
        if (consumer.outer() !== "rootspecific") throw new Error("transitive methods are broken")
        if (!(baseLess instanceof Empty)) throw new Error("Empty is not the zero runtime base")
    `),
        true
    )

    assertBuildAndRuntime(t, results)
})

it("replays a cross-file required-base plan without importing the unexported base", async (t: Test) => {
    const results = await buildBoth(
        [
            {
                fileName : "mixins.ts",
                text     : trimIndent(`
                import { mixin } from "ts-mixin-class"

                class RootBase {
                    root(): string {
                        return "root"
                    }
                }

                class SpecificBase extends RootBase {
                    specific(): string {
                        return "specific"
                    }
                }

                @mixin()
                export class NeedsRoot extends RootBase {
                    fromRoot(): string {
                        return this.root()
                    }
                }

                @mixin()
                export class NeedsSpecific extends SpecificBase {
                    fromSpecific(): string {
                        return this.specific()
                    }
                }

                export function hasSpecificBase(value: object): boolean {
                    return value instanceof SpecificBase
                }
            `)
            },
            {
                fileName : "source.ts",
                text     : trimIndent(`
                import { NeedsRoot, NeedsSpecific, hasSpecificBase } from "./mixins.js"

                class Consumer implements NeedsRoot, NeedsSpecific {
                }

                const consumer = new Consumer()

                if (!hasSpecificBase(consumer)) throw new Error("the cross-file plan selected the wrong base")
                if (!(consumer instanceof NeedsRoot)) throw new Error("NeedsRoot was not applied")
                if (!(consumer instanceof NeedsSpecific)) throw new Error("NeedsSpecific was not applied")
                if (consumer.fromRoot() !== "root") throw new Error("the root-base layer is broken")
                if (consumer.fromSpecific() !== "specific") throw new Error("the specific-base layer is broken")
            `)
            }
        ],
        true
    )

    assertBuildAndRuntime(t, results)
})

it("selects and validates multiple required bases inside a nested scope", async (t: Test) => {
    const compatible = await buildBoth(
        trimIndent(`
        import { mixin } from "ts-mixin-class"

        export function makeNested(): boolean {
            class RootBase {
            }

            class SpecificBase extends RootBase {
            }

            @mixin()
            class NeedsRoot extends RootBase {
            }

            @mixin()
            class NeedsSpecific extends SpecificBase {
            }

            @mixin()
            class Composite implements NeedsRoot, NeedsSpecific {
            }

            class Consumer implements Composite {
            }

            const value = new Consumer()

            return value instanceof SpecificBase &&
                value instanceof NeedsRoot &&
                value instanceof NeedsSpecific &&
                value instanceof Composite
        }

        if (!makeNested()) throw new Error("the nested base plan selected the wrong base")
    `),
        true
    )

    assertBuildAndRuntime(t, compatible)

    const incompatible = await buildBoth(trimIndent(`
        import { mixin } from "ts-mixin-class"

        export function badNested(): void {
            class LeftBase {
            }

            class RightBase {
            }

            @mixin()
            class NeedsLeft extends LeftBase {
            }

            @mixin()
            class NeedsRight extends RightBase {
            }

            class Broken implements NeedsLeft, NeedsRight {
            }

            void Broken
        }
    `))

    assertRequiredBaseConflict(t, incompatible, [ "LeftBase", "RightBase", "NeedsLeft", "NeedsRight" ])
})

it("rejects unrelated and sibling required bases through transitive dependencies", async (t: Test) => {
    const unrelated = await buildBoth(trimIndent(`
        import { mixin } from "ts-mixin-class"

        class AlphaBase {
        }

        class BetaBase {
        }

        @mixin()
        class NeedsAlpha extends AlphaBase {
        }

        @mixin()
        class NeedsBeta extends BetaBase {
        }

        @mixin()
        class AlphaComposite implements NeedsAlpha {
        }

        class Broken implements AlphaComposite, NeedsBeta {
        }

        void Broken
    `))

    assertRequiredBaseConflict(t, unrelated, [ "AlphaBase", "BetaBase", "NeedsAlpha", "NeedsBeta" ])

    const siblings = await buildBoth(trimIndent(`
        import { mixin } from "ts-mixin-class"

        class RootBase {
        }

        class LeftBase extends RootBase {
        }

        class RightBase extends RootBase {
        }

        @mixin()
        class NeedsLeft extends LeftBase {
        }

        @mixin()
        class NeedsRight extends RightBase {
        }

        class Broken implements NeedsLeft, NeedsRight {
        }

        void Broken
    `))

    assertRequiredBaseConflict(t, siblings, [ "LeftBase", "RightBase", "NeedsLeft", "NeedsRight" ])
})

it("rejects incompatible instantiations of the same generic required base", async (t: Test) => {
    const results = await buildBoth(trimIndent(`
        import { mixin } from "ts-mixin-class"

        class GenericBase<T> {
            value!: T
        }

        @mixin()
        class NeedsString extends GenericBase<string> {
        }

        @mixin()
        class NeedsNumber extends GenericBase<number> {
        }

        class Broken implements NeedsString, NeedsNumber {
        }

        void Broken
    `))

    assertRequiredBaseConflict(t, results, [
        "GenericBase<string>",
        "GenericBase<number>",
        "NeedsString",
        "NeedsNumber"
    ])
})

it("requires an explicit consumer or mixin base to satisfy the transitive most-specific base", async (t: Test) => {
    const valid = await buildBoth(
        trimIndent(`
        import { mixin } from "ts-mixin-class"

        class RootBase {
        }

        class SpecificBase extends RootBase {
        }

        class OwnBase extends SpecificBase {
        }

        @mixin()
        class NeedsRoot extends RootBase {
        }

        @mixin()
        class NeedsSpecific extends SpecificBase {
        }

        @mixin()
        class Composite extends OwnBase implements NeedsRoot, NeedsSpecific {
        }

        class Consumer extends OwnBase implements Composite {
        }

        const composite = new Composite()
        const consumer  = new Consumer()

        if (!(composite instanceof OwnBase)) throw new Error("the mixin's explicit base was not preserved")
        if (!(consumer instanceof OwnBase)) throw new Error("the consumer's explicit base was not preserved")
    `),
        true
    )

    assertBuildAndRuntime(t, valid)

    const invalid = await buildBoth(trimIndent(`
        import { mixin } from "ts-mixin-class"

        class RootBase {
        }

        class SpecificBase extends RootBase {
        }

        @mixin()
        class NeedsSpecific extends SpecificBase {
        }

        @mixin()
        class BadComposite extends RootBase implements NeedsSpecific {
        }

        class BadConsumer extends RootBase implements NeedsSpecific {
        }

        void [ BadComposite, BadConsumer ]
    `))

    for (const result of [ invalid.emit, invalid.sourceView ]) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, "an explicit ancestor of the effective required base is rejected")
        t.match(output, "TS990014", `reports the native mismatch CODE (tooling keys on it).\n${output}`)
        t.match(output, "Mixin required base mismatch", `reports the ordinary explicit-base mismatch.\n${output}`)
        t.match(output, "SpecificBase", `names the most-specific requirement.\n${output}`)
    }
})

// --- review pins (see REVIEW.md) -------------------------------------------

// Finding 2: the explicit-base validation must not depend on the consumer file's TEXT
// containing the package name. The consumer module below imports only its mixin module —
// the diagnostic must still fire in both planes, as native TS990014.
it("rejects an explicit-base mismatch declared in a file that never mentions the package", async (t: Test) => {
    const results = await buildBoth([
        {
            fileName : "mixdef.ts",
            text     : trimIndent(`
            import { mixin } from "ts-mixin-class"

            export class RootBase {
            }

            export class SpecificBase extends RootBase {
            }

            @mixin()
            export class NeedsSpecific extends SpecificBase {
            }
        `)
        },
        {
            fileName : "source.ts",
            text     : trimIndent(`
            import { NeedsSpecific, RootBase } from "./mixdef.js"

            export class Bad extends RootBase implements NeedsSpecific {
            }
        `)
        }
    ])

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: the ancestor base is rejected`)
        t.match(output, "Mixin required base mismatch", `${plane}: reports the mismatch (checker-authored for plain consumers, suppressible).\n${output}`)
        t.match(output, "SpecificBase", `${plane}: names the requirement.\n${output}`)
    }
})

// Finding 3 (ancestry): a nominally-valid GENERIC chain must not be a conflict —
// GenericMid<string> IS a GenericRoot<string[]> through `extends GenericRoot<T[]>`.
it("accepts compatible generic required bases across an instantiated inheritance chain", async (t: Test) => {
    const results = await buildBoth(
        trimIndent(`
        import { mixin } from "ts-mixin-class"

        class GenericRoot<U> {
            root!: U
        }

        class GenericMid<T> extends GenericRoot<T[]> {
            mid!: T
        }

        @mixin()
        class NeedsMid extends GenericMid<string> {
        }

        @mixin()
        class NeedsRoot extends GenericRoot<string[]> {
        }

        class Consumer implements NeedsMid, NeedsRoot {
        }

        const consumer = new Consumer()

        if (!(consumer instanceof GenericMid)) throw new Error("the most-specific generic base was not selected")
        if (!(consumer instanceof GenericRoot)) throw new Error("the generic base ancestry was not preserved")
    `),
        true
    )

    assertBuildAndRuntime(t, results)
})

// Finding 3 (use site): a generic mixin applied with the consumer's own type parameter.
// The compile-time identity comparison cannot decide `Base<U>` vs the declared `Base<T>`
// constraint — it must degrade to "unknown" (no diagnostic, runtime resolves the base),
// never reject valid code.
it("accepts a generic mixin applied over the consumer's matching generic base", async (t: Test) => {
    const results = await buildBoth(trimIndent(`
        import { mixin } from "ts-mixin-class"

        class GenericBase<T> {
            value!: T
        }

        @mixin()
        class GenericMixin<T> extends GenericBase<T> {
        }

        export class Holder<U> extends GenericBase<U> implements GenericMixin<U> {
        }
    `))

    t.equal(results.emit.exitCode, 0, `emit accepts the matching generic base.\n${commandOutput(results.emit)}`)
    t.equal(results.sourceView.exitCode, 0, `source view accepts it.\n${commandOutput(results.sourceView)}`)
})

// Finding 6: a NESTED mixin sharing a top-level mixin's name must resolve ITS OWN
// constraint set, not the top-level twin's.
it("resolves a nested mixin's own required base when a top-level mixin shares its name", async (t: Test) => {
    const results = await buildBoth(
        trimIndent(`
        import { mixin } from "ts-mixin-class"

        export class BaseA {
            a(): string {
                return "a"
            }
        }

        export class BaseB {
            b(): string {
                return "b"
            }
        }

        @mixin()
        class Tagger extends BaseA {
        }

        class TopConsumer implements Tagger {
        }

        export function makeNested(): object {
            @mixin()
            class Tagger extends BaseB {
            }

            class NestedConsumer implements Tagger {
            }

            return new NestedConsumer()
        }

        const top    = new TopConsumer()
        const nested = makeNested()

        if (!(top instanceof BaseA)) throw new Error("the top-level consumer lost BaseA")
        if (!(nested instanceof BaseB)) throw new Error("the nested consumer lost BaseB")
        if (nested instanceof BaseA) throw new Error("the nested consumer wrongly took the top-level base")
    `),
        true
    )

    assertBuildAndRuntime(t, results)
})

// Finding 7: a dependency's OWN explicit-base mismatch must be reported once, on the
// dependency — not re-attributed to every downstream mixin whose own base is valid.
it("reports an explicit-base mismatch only on the mixin that declares it", async (t: Test) => {
    const results = await buildBoth(trimIndent(`
        import { mixin } from "ts-mixin-class"

        class RootBase {
        }

        class SpecificBase extends RootBase {
        }

        @mixin()
        class NeedsSpecific extends SpecificBase {
        }

        @mixin()
        class BadMiddle extends RootBase implements NeedsSpecific {
        }

        @mixin()
        class GoodOuter extends SpecificBase implements BadMiddle {
        }

        void GoodOuter
    `))

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: the genuine mismatch is rejected`)
        t.match(output, "BadMiddle declares base RootBase", `${plane}: attributes the mismatch to BadMiddle.\n${output}`)
        t.notMatch(
            output,
            "GoodOuter declares base",
            `${plane}: GoodOuter (whose own base satisfies the requirement) is not re-flagged.\n${output}`
        )
    }
})
