import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// Constructor / member SHAPES around the transform's rewrites: OVERLOADED constructors (the
// synthetic super() must target only the implementation), a consumer's OWN private surface
// (#private, private/protected members, a private constructor + static factory — only MIXIN
// members must be public, §11.1).

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

it("a consumer with an OVERLOADED constructor keeps its overloads through the heritage rewrite", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Stamped {
            at: number = 0

            stamp(): number {
                return this.at
            }
        }

        class Event implements Stamped {
            kind: string

            constructor(kind: string)
            constructor(kind: string, at: number)
            constructor(kind: string, at: number = 0) {
                this.kind = kind
                this.at   = at
            }
        }

        const click = new Event("click")
        const move  = new Event("move", 5)

        const stamped: number = move.stamp()

        function typeOnlyChecks(): void {
            // @ts-expect-error no zero-argument overload
            new Event()
        }

        void typeOnlyChecks
        void [ click, stamped ]
    `))

    t.equal(
        result.exitCode,
        0,
        `both overloads resolve; the synthetic super() lands only in the implementation.\n${commandOutput(result)}`
    )
})

it("a MIXIN with an OVERLOADED constructor keeps its overloads through the factory wrap", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Pointed {
            x: number = 0

            constructor()
            constructor(x: number)
            constructor(x: number = 0) {
                this.x = x
            }
        }

        class Dot implements Pointed {
        }

        const origin = new Pointed()
        const offset = new Pointed(3)
        const dot    = new Dot()

        const where: number = offset.x

        void [ origin, dot, where ]
    `))

    t.equal(
        result.exitCode,
        0,
        `constructor overload signatures survive into the runtime factory class.\n${commandOutput(result)}`
    )
})

it("a consumer's OWN private surface is untouched: #private, private/protected members", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Greeter {
            greet(): string {
                return "hi"
            }
        }

        class Vault implements Greeter {
            #secret: string = "s3cr3t"

            private level: number = 1

            protected tier(): string {
                return "t" + String(this.level)
            }

            reveal(): string {
                return this.#secret + "/" + this.tier() + "/" + this.greet()
            }
        }

        const vault = new Vault()

        const revealed: string = vault.reveal()

        function typeOnlyChecks(): void {
            // @ts-expect-error the consumer's own private member stays private
            vault.level = 2

            // @ts-expect-error the consumer's own protected member stays protected
            vault.tier()
        }

        void typeOnlyChecks
        void revealed
    `))

    t.equal(
        result.exitCode,
        0,
        `only MIXIN members must be public — the consumer's own private surface compiles.\n${commandOutput(result)}`
    )
})

it("a consumer with a PRIVATE constructor + static factory (singleton pattern)", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Greeter {
            greet(): string {
                return "hi"
            }
        }

        class Single implements Greeter {
            private constructor() {
            }

            static instance(): Single {
                return new Single()
            }
        }

        const single = Single.instance()

        const greeted: string = single.greet()

        function typeOnlyChecks(): void {
            // @ts-expect-error the constructor is private — construction goes through the factory
            new Single()
        }

        void typeOnlyChecks
        void greeted
    `)

    const emit = await build(source)

    t.equal(emit.exitCode, 0, `emit: the private constructor survives the heritage rewrite.\n${commandOutput(emit)}`)

    const sourceView = await build(source, { noEmit: true })

    t.equal(sourceView.exitCode, 0, `source view agrees.\n${commandOutput(sourceView)}`)
})
