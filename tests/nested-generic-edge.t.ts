import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

// Low-priority EDGE coverage. Nested classes that capture an enclosing generic type parameter
// are legal TypeScript, but they combine several unusually sharp transformer surfaces: generated
// siblings must stay in the function block, cloned type nodes must keep the outer type scope, and
// a nested construction config alias must refer to that same outer parameter. If this ever finds a
// deep transformer limitation, confirm that supporting the shape is worth the complexity before
// changing source-view positioning or declaration-generation invariants.
it("[edge] nested mixin and construction classes capture an enclosing generic parameter", async (t: Test) => {
    const source     = trimIndent(`
        import { Base, mixin } from "ts-mixin-class"

        function build<T>(value: T): [T, T] {
            @mixin()
            class CapturedMixin {
                public captured: T = value
            }

            class LocalConsumer implements CapturedMixin {
            }

            class LocalConstruction extends Base {
                public configured!: T
            }

            const consumed = new LocalConsumer()
            const constructed = LocalConstruction.new({ configured: value })

            const captured: T = consumed.captured
            const configured: T = constructed.configured

            return [ captured, configured ]
        }

        const numeric: [number, number] = build(42)
        const textual: [string, string] = build("value")

        void [ numeric, textual ]
    `)
    const emit       = await buildConstructionSource(source)
    const sourceView = await buildConstructionSource(source, { noEmit: true })

    t.equal(emit.exitCode, 0, `emit: nested generated declarations retain the enclosing T.\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0, `source view: nested generated declarations retain the enclosing T.\n${commandOutput(sourceView)}`)
})
