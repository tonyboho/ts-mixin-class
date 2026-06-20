import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot } from "./util.js"
import { runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// SPEC (§7.5c): a settable accessor is included in `.new` config "typed by the SETTER's
// parameter type". This matters when the getter and setter types DIFFER (a getter that
// returns a narrow type, a setter that accepts a wider one — legal since TS 4.3). Because
// `.new`'s runtime is `Object.assign`, which invokes the setter, the config field should
// accept anything the SETTER accepts (`number | string`), not only the getter's type.
//
// This test asserts `.new({ value: "str" })` compiles (a setter-valid, getter-invalid
// value). The generated `<Class>Config` emits a settable accessor as an explicit
// `value?: <setterParamType>` member (not `Pick<Class, "value">`, which would read the
// GETTER type `number`), so a setter-valid argument is accepted in emit and source-view.
const splitAccessorText = `
import { Base } from "ts-mixin-class/base"

class Model extends Base {
    public id: string = ""

    // private backing storage — excluded from config, so 'id' is the only required field
    private _v: number = 0

    public get value(): number {
        return this._v
    }

    // setter accepts a WIDER type than the getter returns
    public set value(input: number | string) {
        this._v = typeof input === "string" ? input.length : input
    }
}

// A setter-valid (getter-invalid) argument: the setter accepts a string, normalizes it.
const fromString = Model.new({ id: "a", value: "hello" })
const fromNumber = Model.new({ id: "b", value: 3 })

// 'value' is optional (accessor) — may be omitted.
const minimal = Model.new({ id: "c" })

void [ fromString.value, fromNumber.value, minimal.value ]
`

async function build(compilerOptions: Record<string, unknown> | undefined): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : [ { fileName : "source.ts", text : splitAccessorText } ]
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

it("types a split get/set accessor in .new config by the setter parameter type", async (t: Test) => {
    const emit       = await build(undefined)
    const sourceView = await build({ noEmit : true })

    t.equal(emit.exitCode, 0,
        `.new should accept a setter-valid value for a split get/set accessor (emit).\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0,
        `.new should accept a setter-valid value for a split get/set accessor (source-view).\n${commandOutput(sourceView)}`)
})
