import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"

async function build(source: string, noEmit = false): Promise<Awaited<ReturnType<typeof runCommand>>> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : noEmit ? { noEmit: true } : undefined,
        sourceFiles            : [ { fileName: "source.ts", text: source } ]
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

it("generic and overloaded static methods plus symbol/static accessors survive mixin composition", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const token: unique symbol = Symbol("token")

        @mixin()
        class StaticShapes {
            static state: string = "initial"

            static identity<T>(value: T): T {
                return value
            }

            static parse(value: string): string
            static parse(value: number): number
            static parse(value: string | number): string | number {
                return value
            }

            static get current(): string {
                return this.state
            }

            static set current(value: string) {
                this.state = value
            }

            static [token](): string {
                return "symbol"
            }
        }

        class Consumer implements StaticShapes {
        }

        const genericString: string = Consumer.identity("x")
        const genericNumber: number = Consumer.identity(1)
        const parsedString: string = Consumer.parse("x")
        const parsedNumber: number = Consumer.parse(1)

        Consumer.current = "changed"

        const accessed: string = Consumer.current
        const symbolResult: string = Consumer[token]()

        function typeOnlyChecks(): void {
            // @ts-expect-error overloads accept only string or number
            Consumer.parse(true)

            // @ts-expect-error the static accessor remains string-valued
            Consumer.current = 1
        }

        void [ genericString, genericNumber, parsedString, parsedNumber, accessed, symbolResult, typeOnlyChecks ]
    `)

    for (const [ plane, result ] of [ [ "emit", await build(source) ], [ "source view", await build(source, true) ] ] as const) {
        t.equal(result.exitCode, 0, `${plane}: every exotic static shape remains correctly typed.\n${commandOutput(result)}`)
    }
})

it("static accessor and symbol-key collisions are diagnosed in both planes", async (t: Test) => {
    const source = trimIndent(`
        import { mixin } from "ts-mixin-class"

        const shared: unique symbol = Symbol("shared")

        @mixin()
        class Left {
            static get value(): string { return "left" }
            static [shared]: string = "left"
        }

        @mixin()
        class Right {
            static get value(): number { return 1 }
            static [shared]: number = 1
        }

        class Broken implements Left, Right {
        }

        void Broken
    `)

    for (const [ plane, result ] of [ [ "emit", await build(source) ], [ "source view", await build(source, true) ] ] as const) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: incompatible static accessor/symbol declarations are rejected`)
        t.match(output, "Static mixin member collision", `${plane}: the collision uses the dedicated diagnostic.\n${output}`)
        t.match(output, "value", `${plane}: the ordinary accessor collision is named`)
        t.match(output, "shared", `${plane}: the symbol-keyed collision is named too`)
    }
})

it("static collisions normalize equivalent JavaScript property-key spellings", async (t: Test) => {
    const cases = [
        {
            description : "identifier and computed string literal",
            expectedKey : "foo",
            leftMember  : 'static foo: string = "left"',
            rightMember : 'static ["foo"]: number = 1'
        },
        {
            description : "numeric and string-literal numeric name",
            expectedKey : "0",
            leftMember  : 'static 0: string = "left"',
            rightMember : 'static "0": number = 1'
        }
    ]

    for (const collision of cases) {
        const source = trimIndent(`
            import { mixin } from "ts-mixin-class"

            @mixin()
            class Left {
                ${collision.leftMember}
            }

            @mixin()
            class Right {
                ${collision.rightMember}
            }

            class Broken implements Left, Right {
            }

            void Broken
        `)

        for (const [ plane, result ] of [ [ "emit", await build(source) ], [ "source view", await build(source, true) ] ] as const) {
            const output = commandOutput(result)

            t.ne(result.exitCode, 0, `${plane}: ${collision.description} resolves to one incompatible runtime key`)
            t.match(output, "Static mixin member collision", `${plane}: the normalized key uses the dedicated diagnostic.\n${output}`)
            t.match(output, collision.expectedKey, `${plane}: the diagnostic names the normalized ${collision.expectedKey} key`)
        }
    }
})
