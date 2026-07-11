import path from "node:path"
import { readFile } from "node:fs/promises"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult, TypeScriptFixtureSourceFile } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

type BuildResults = {
    emit       : CommandResult,
    sourceView : CommandResult,
    runtime    : CommandResult | undefined,
    emittedJs  : string | undefined
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
        const emittedJs  = emit.exitCode === 0
            ? await readFile(path.join(fixture.directory, "dist", "source.js"), "utf8")
            : undefined

        return { emit, sourceView, runtime, emittedJs }
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

// --- review pins (2026-07 required-base review; see git history) ------------

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

// --- generic use-site resolution --------------------------------------------
//
// A generic mixin's constraint (`@mixin class M<T> extends Base<T>`) is declared in terms
// of ITS OWN type parameter. The resolver must interpret it under the USE-SITE substitution
// (`implements M<U>` maps T -> U) and compare type parameters SYMBOLICALLY (the same
// parameter object equals itself; a parameter against anything else is "unknown", never a
// conflict). Characterization probe (2026-07-11) showed the pre-fix state: the raw
// declaration-site `Base<T>` leaked into the generated `$base` heritage (TS2304
// "Cannot find name 'T'" + TS2320 on VALID code), and concrete use-site mismatches were
// invisible in source view.

const genericMixinPreamble = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class GenericBase<T> {
        value!: T

        tag(): string {
            return "base"
        }
    }

    @mixin()
    class GenericMixin<T> extends GenericBase<T> {
        twice(): T[] {
            return [ this.value, this.value ]
        }
    }
`)

it("plans a generic required base for a consumer without an explicit base", async (t: Test) => {
    const results = await buildBoth(
        `${genericMixinPreamble}\n` + trimIndent(`
        class Consumer<U> implements GenericMixin<U> {
        }

        const consumer = new Consumer<string>()

        if (!(consumer instanceof GenericBase)) throw new Error("the generic required base was not applied")
        if (!(consumer instanceof GenericMixin)) throw new Error("the mixin was not applied")
        if (consumer.tag() !== "base") throw new Error("the base layer is broken")
    `),
        true
    )

    assertBuildAndRuntime(t, results)
    // The emit contract for a SELECTED base: the base expression is the literal
    // `undefined` and the trailing one-based plan index supplies it at runtime —
    // a plan index (not a missing argument) is what distinguishes "planned" from
    // "runtime scan".
    t.match(
        results.emittedJs ?? "",
        '__mixinChainLinearized__(undefined, [GenericMixin], [[0, 0, 1]], "verify", 1)',
        "the generic required base is planned (one-based index, no runtime scan)"
    )
})

it("selects the most-specific generic required base decidable only at the use site", async (t: Test) => {
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
        class NeedsMid<T> extends GenericMid<T> {
        }

        @mixin()
        class NeedsRoot<T> extends GenericRoot<T[]> {
        }

        class Consumer<U> implements NeedsMid<U>, NeedsRoot<U> {
        }

        const consumer = new Consumer<string>()

        if (!(consumer instanceof GenericMid)) throw new Error("the most-specific generic base was not selected")
        if (!(consumer instanceof GenericRoot)) throw new Error("the generic base ancestry was not preserved")
    `),
        true
    )

    assertBuildAndRuntime(t, results)
    t.match(
        results.emittedJs ?? "",
        '"verify", 1)',
        "the most-specific generic base (NeedsMid, index 1) is planned — no runtime scan"
    )
})

it("rejects incompatible concrete instantiations reached through use-site arguments", async (t: Test) => {
    const results = await buildBoth(`${genericMixinPreamble}\n` + trimIndent(`
        @mixin()
        class OtherMixin<T> extends GenericBase<T> {
        }

        class Broken implements GenericMixin<string>, OtherMixin<number> {
        }

        void Broken
    `))

    assertRequiredBaseConflict(t, results, [
        "GenericBase<string>",
        "GenericBase<number>",
        "GenericMixin",
        "OtherMixin"
    ])
})

it("rejects a concrete explicit base mismatching the use-site instantiation in both planes", async (t: Test) => {
    const results = await buildBoth(`${genericMixinPreamble}\n` + trimIndent(`
        export class Bad extends GenericBase<number> implements GenericMixin<string> {
        }
    `))

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: the mismatched instantiation is rejected`)
        t.match(output, "Mixin required base mismatch", `${plane}: reports the mismatch.\n${output}`)
        t.match(output, "GenericBase<string>", `${plane}: names the use-site-instantiated requirement.\n${output}`)
    }
})

it("reports a mixin's mismatched concrete explicit base as native TS990014", async (t: Test) => {
    const results = await buildBoth(`${genericMixinPreamble}\n` + trimIndent(`
        @mixin()
        class BadComposite extends GenericBase<number> implements GenericMixin<string> {
        }

        void BadComposite
    `))

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: the mixin's mismatched instantiation is rejected`)
        t.match(output, "TS990014", `${plane}: reports the native mismatch code.\n${output}`)
        t.match(output, "GenericBase<string>", `${plane}: names the use-site-instantiated requirement.\n${output}`)
    }
})

it("composes use-site substitutions through a transitive generic mixin chain", async (t: Test) => {
    const valid = await buildBoth(
        `${genericMixinPreamble}\n` + trimIndent(`
        @mixin()
        class Outer<T> implements GenericMixin<T> {
            outer(): T {
                return this.value
            }
        }

        class Consumer extends GenericBase<string> implements Outer<string> {
        }

        const consumer = new Consumer()

        if (!(consumer instanceof GenericBase)) throw new Error("the transitive generic base was not applied")
        if (!(consumer instanceof Outer)) throw new Error("Outer was not applied")
    `),
        true
    )

    assertBuildAndRuntime(t, valid)

    const invalid = await buildBoth(`${genericMixinPreamble}\n` + trimIndent(`
        @mixin()
        class Outer<T> implements GenericMixin<T> {
            outer(): T {
                return this.value
            }
        }

        export class Bad extends GenericBase<number> implements Outer<string> {
        }
    `))

    for (const [ plane, result ] of [ [ "emit", invalid.emit ], [ "source view", invalid.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: the transitively-mismatched instantiation is rejected`)
        t.match(output, "Mixin required base mismatch", `${plane}: reports the mismatch.\n${output}`)
        t.match(output, "GenericBase<string>", `${plane}: names the composed requirement.\n${output}`)
    }
})

// A CONSTRAINT on the consumer's parameter (`<U extends string>`) must not disturb the
// symbolic comparison: the same parameter object still equals itself, so the base is
// planned at compile time. (Subtyping implications of the constraint are deliberately
// NOT interpreted — that is the structural checker's jurisdiction.)
it("plans the base for a constrained consumer parameter through symbolic equality", async (t: Test) => {
    const results = await buildBoth(
        trimIndent(`
        import { mixin } from "ts-mixin-class"

        class GenericBase<T> {
            tag(): string {
                return "base"
            }
        }

        @mixin()
        class MixinA<T> extends GenericBase<T> {
        }

        @mixin()
        class MixinB<T> extends GenericBase<T> {
        }

        class Consumer<U extends string> implements MixinA<U>, MixinB<U> {
        }

        const consumer = new Consumer<"x">()

        if (!(consumer instanceof GenericBase)) throw new Error("the generic required base was not applied")
        if (consumer.tag() !== "base") throw new Error("the base layer is broken")
    `),
        true
    )

    assertBuildAndRuntime(t, results)
    t.match(
        results.emittedJs ?? "",
        '"verify", 1)',
        "a constrained parameter still compares symbolically — the base is planned, no runtime scan"
    )
})

// A use site relying on a parameter DEFAULT (`implements WithDefault` with no arguments)
// is not interpreted (resolving defaults would be another slice of checker work): the
// resolution must degrade GRACEFULLY to the runtime scan — no crash, no false conflict,
// no plan index — and the runtime resolves the base precisely.
it("degrades a defaulted use site to the runtime scan gracefully", async (t: Test) => {
    const results = await buildBoth(
        trimIndent(`
        import { mixin } from "ts-mixin-class"

        class GenericBase<T> {
            tag(): string {
                return "base"
            }
        }

        @mixin()
        class WithDefault<T = string> extends GenericBase<T> {
        }

        @mixin()
        class Concrete extends GenericBase<string> {
        }

        class Consumer implements WithDefault, Concrete {
        }

        const consumer = new Consumer()

        if (!(consumer instanceof GenericBase)) throw new Error("the runtime scan did not resolve the base")
        if (consumer.tag() !== "base") throw new Error("the base layer is broken")
    `),
        true
    )

    assertBuildAndRuntime(t, results)
    t.match(
        results.emittedJs ?? "",
        '"verify")',
        "no plan index is emitted — the runtime scan owns the defaulted use site"
    )
    t.notMatch(
        results.emittedJs ?? "",
        '"verify", ',
        "the degrade is to NO plan, never to a wrong index"
    )
})

// A genuinely undecidable combination (a free consumer parameter against a concrete
// argument) may keep its structural checker errors — but the transform must never leak a
// foreign type parameter into the generated heritage (the pre-fix TS2304 garbage).
it("never leaks a mixin's own type parameter into the consumer's generated heritage", async (t: Test) => {
    const results = await buildBoth(`${genericMixinPreamble}\n` + trimIndent(`
        @mixin()
        class OtherMixin<T> extends GenericBase<T> {
        }

        export class Undecidable<U> implements GenericMixin<U>, OtherMixin<string> {
        }
    `))

    for (const [ plane, result ] of [ [ "emit", results.emit ], [ "source view", results.sourceView ] ] as const) {
        const output = commandOutput(result)

        t.notMatch(output, "Cannot find name", `${plane}: no foreign type parameter leaks out of scope.\n${output}`)
    }
})
