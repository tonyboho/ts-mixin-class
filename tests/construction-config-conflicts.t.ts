import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

async function buildBothPlanes(
    source: string,
    compilerOptions?: Record<string, unknown>
): Promise<readonly [
    readonly ["emit", Awaited<ReturnType<typeof buildConstructionSource>>],
    readonly ["source view", Awaited<ReturnType<typeof buildConstructionSource>>]
]> {
    return [
        [ "emit", await buildConstructionSource(source, compilerOptions) ],
        [ "source view", await buildConstructionSource(source, { ...compilerOptions, noEmit: true }) ]
    ]
}

it("different types for the same field are rejected by TypeScript in both planes", async (t: Test) => {
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        class TextValue extends Base {
            public value: string = ""
        }

        @mixin()
        class NumericValue extends Base {
            public value: number = 0
        }

        class Broken extends Base implements TextValue, NumericValue {
        }

        void Broken
    `)

    for (const [ plane, result ] of await buildBothPlanes(source)) {
        const output = commandOutput(result)

        t.ne(result.exitCode, 0, `${plane}: incompatible field types do not silently form a config`)
        t.match(output, "value", `${plane}: TypeScript's incompatibility diagnostic names the shared field.\n${output}`)
    }
})

it("a required config key stays required through optional mixin and class redeclarations", async (t: Test) => {
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        class RequiredValue extends Base {
            public value!: string
        }

        @mixin()
        class OptionalValue extends Base {
            public value: string = "optional"
        }

        @mixin()
        class OptionalDependency extends Base implements RequiredValue {
            public value: string = "dependency-default"
        }

        class OptionalFirst extends Base implements OptionalValue, RequiredValue {
        }

        class RequiredFirst extends Base implements RequiredValue, OptionalValue {
        }

        class OwnOptional extends Base implements OptionalDependency {
            public value: string = "own-default"
        }

        const a = OptionalFirst.new({ value: "a" })
        const b = RequiredFirst.new({ value: "b" })
        const c = OptionalDependency.new({ value: "c" })
        const d = OwnOptional.new({ value: "d" })

        function typeOnlyChecks(): void {
            // @ts-expect-error a required contributor wins independently of implements order
            OptionalFirst.new({})

            // @ts-expect-error listing the required mixin first keeps the same monotonic contract
            RequiredFirst.new({})

            // @ts-expect-error an optional nearer dependency declaration cannot relax the deep requirement
            OptionalDependency.new({})

            // @ts-expect-error even the consumer's own optional redeclaration cannot relax it
            OwnOptional.new({})
        }

        void [ a, b, c, d, typeOnlyChecks ]
    `)

    for (const [ plane, result ] of await buildBothPlanes(source)) {
        t.equal(
            result.exitCode,
            0,
            `${plane}: requiredness is monotonic across C3 order, dependencies and own redeclarations.\n${commandOutput(result)}`
        )
    }
})

it("the nearest C3 layer chooses a shared config key's field/setter write type", async (t: Test) => {
    const source = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        class WideAccessor extends Base {
            stored: number = 0

            public get value(): number {
                return this.stored
            }

            public set value(input: number | string) {
                this.stored = Number(input)
            }
        }

        @mixin()
        class NarrowField extends Base {
            public value: number = 0
        }

        class FieldNearest extends Base implements NarrowField, WideAccessor {
        }

        class AccessorNearest extends Base implements WideAccessor, NarrowField {
        }

        const field = FieldNearest.new({ value: 1 })
        const accessorFromNumber = AccessorNearest.new({ value: 1 })
        const accessorFromString = AccessorNearest.new({ value: "2" })

        const fieldRead: number = field.value
        const accessorRead: number = accessorFromString.value

        function typeOnlyChecks(): void {
            // @ts-expect-error the nearest field narrows the config write type to number
            FieldNearest.new({ value: "2" })

            // @ts-expect-error the nearest accessor still rejects values outside its setter type
            AccessorNearest.new({ value: true })
        }

        void [ fieldRead, accessorRead, accessorFromNumber, typeOnlyChecks ]
    `)

    // Field/accessor replacement is deliberately legal only under SET semantics. The test is
    // about config-write precedence, not the independent DEFINE-semantics TS990010 guard.
    for (const [ plane, result ] of await buildBothPlanes(source, { useDefineForClassFields: false })) {
        t.equal(
            result.exitCode,
            0,
            `${plane}: the first (nearest) C3 declaration determines the config write type.\n${commandOutput(result)}`
        )
    }
})
