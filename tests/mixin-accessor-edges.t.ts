import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// ACCESSOR edges across the chain: super-access to a mixin's accessor from a consumer
// override (the pre-transform consumer has NO extends clause — `super.value` is legal only
// because BOTH planes give it a base), a polymorphic `this`-returning getter (§1.14's
// accessor twin), and a SYMBOL-named accessor (§1.17's accessor twin).

async function build(text: string, compilerOptions?: Record<string, unknown>): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })

    try {
        return await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )
    } finally {
        await fixture.dispose()
    }
}

const superAccessorOverride = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class Measured {
        stored: number = 10

        get value(): number {
            return this.stored
        }

        set value(input: number) {
            this.stored = input
        }
    }

    class Doubling implements Measured {
        get value(): number {
            return super.value * 2
        }

        set value(input: number) {
            super.value = input
        }
    }

    const doubling = new Doubling()

    doubling.value = 5

    const read: number = doubling.value

    void read
`)

it("a consumer accessor override reaches the mixin's accessor through super (emit)", async (t: Test) => {
    const result = await build(superAccessorOverride)

    t.equal(
        result.exitCode,
        0,
        `super.value get/set resolves against the generated base.\n${commandOutput(result)}`
    )
})

it("a consumer accessor override reaches the mixin's accessor through super (source view)", async (t: Test) => {
    const result = await build(superAccessorOverride, { noEmit: true })

    t.equal(result.exitCode, 0, `the source-view plane agrees.\n${commandOutput(result)}`)
})

it("a mixin getter with a polymorphic `this` return narrows to the consumer", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Chained {
            count: number = 0

            get self(): this {
                return this
            }
        }

        class Builder implements Chained {
            bump(): this {
                this.count += 1
                return this
            }
        }

        // The getter's \`this\` narrows to Builder, so a Builder-only member chains off it.
        const builder = new Builder().self.bump().self.bump()

        const built: Builder = builder

        void built
    `))

    t.equal(
        result.exitCode,
        0,
        `the this-returning GETTER narrows at the consumer (§1.14's accessor twin).\n${commandOutput(result)}`
    )
})

it("this-typed accessor SHAPES do not crash the compiler (upstream TS bug workaround)", async (t: Test) => {
    // Plain TS, no transform involved — a TypeScript 6.0 REGRESSION: a `this` type anywhere
    // inside an INTERFACE accessor's annotation crashes the checker
    // (`getConditionalFlowTypeOfType` reads `type.flags` of undefined). Verified: 5.9.3 is
    // clean; 6.0.3 (this repo's pin) and nightly 6.0.0-dev.20260416 crash on
    // `interface I { get self(): this }`. The generated interface therefore falls back to a
    // PROPERTY signature for this-typed accessors — narrowing is identical; only the
    // accessor-ness collapses. See TODO.md "Upstream: report the interface-accessor `this` crash".
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Linked {
            stored: this | undefined

            get pair(): [this, string] {
                return [ this as this, "tag" ]
            }

            set other(value: this) {
                this.stored = value
            }
        }

        class Node2 implements Linked {
            own(): string {
                return "own"
            }
        }

        const node = new Node2()

        node.other = new Node2()

        const paired: [Node2, string] = node.pair
        const owned: string           = paired[0].own()

        void [ paired, owned ]
    `))

    t.equal(
        result.exitCode,
        0,
        `nested / setter-side this types compile through the property-signature fallback.\n${commandOutput(result)}`
    )
})

it("a SYMBOL-named accessor pair survives into the consumer's interface", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Tagged {
            named: string = "tagged"

            get [Symbol.toStringTag](): string {
                return this.named
            }
        }

        class Item implements Tagged {
        }

        const item = new Item()

        const tag: string = item[Symbol.toStringTag]

        // The well-known symbol getter drives Object.prototype.toString.
        const printed: string = Object.prototype.toString.call(item)

        void [ tag, printed ]
    `))

    t.equal(
        result.exitCode,
        0,
        `a computed well-known-symbol GETTER is a typed member of the consumer (§1.17's accessor twin).\n${commandOutput(result)}`
    )
})
