import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

async function assertBothPlanesCompile(t: Test, source: string, description: string): Promise<void> {
    const emit       = await buildConstructionSource(source)
    const sourceView = await buildConstructionSource(source, { noEmit: true })

    t.equal(emit.exitCode, 0, `${description} (emit).\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `${description} (source view).\n${commandOutput(sourceView)}`)
}

it("an empty construction config rejects unknown keys", async (t: Test) => {
    await assertBothPlanesCompile(
        t,
        trimIndent(`
            import { Base, mixin } from "ts-mixin-class"

            class EmptyClass extends Base {
            }

            @mixin()
            class EmptyMixin extends Base {
            }

            class EmptyConsumer extends Base implements EmptyMixin {
            }

            EmptyClass.new()
            EmptyClass.new({})
            EmptyMixin.new()
            EmptyConsumer.new({})

            // @ts-expect-error an empty config still rejects an unknown key
            EmptyClass.new({ unexpected: 1 })

            // @ts-expect-error the standalone construction-mixin twin is exact too
            EmptyMixin.new({ unexpected: 1 })

            // @ts-expect-error composing an empty construction mixin does not widen the config
            EmptyConsumer.new({ unexpected: 1 })
        `),
        "empty class, mixin and consumer configs are exact rather than accepting every object"
    )
})

it("an abstract construction class has no callable .new while a concrete subclass does", async (t: Test) => {
    await assertBothPlanesCompile(
        t,
        trimIndent(`
            import { Base, mixin } from "ts-mixin-class"

            @mixin()
            class Named {
                public name: string = ""
            }

            abstract class AbstractModel extends Base implements Named {
                abstract describe(): string
            }

            // @ts-expect-error an abstract class cannot be instantiated through the static factory
            AbstractModel.new({ name: "abstract" })

            class ConcreteModel extends AbstractModel {
                describe(): string {
                    return this.name
                }
            }

            const concrete = ConcreteModel.new({ name: "concrete" })
            const description: string = concrete.describe()

            void description
        `),
        "the construction factory respects abstractness and reappears on the concrete subclass"
    )
})
