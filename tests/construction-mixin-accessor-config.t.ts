import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot } from "./util.js"
import { runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// §7.5e: §7.5c established that a construction class's OWN public settable accessor is part
// of its `.new` config. This pins the next dimension — a settable accessor contributed by a
// MIXIN the construction consumer implements. `.new`'s `Object.assign` fires the inherited
// setter the same way, so the mixin's settable accessor is aggregated into the consumer's
// config (as an optional key), alongside the mixin's public DATA fields (required unless
// `?`). Here `label` (a get/set pair on the mixin) is optional config; `tag` (a required
// mixin data field) shows the two coexist.
const text = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Labelled {
    public backing?: string

    public tag: string = ""

    public get label(): string {
        return this.backing ?? ""
    }

    public set label(value: string) {
        this.backing = value
    }
}

class Widget extends Base implements Labelled {
    public id: string = ""
}

// The mixin's settable accessor 'label' is optional config; 'tag' (required mixin field)
// and 'id' (the consumer's own required field) are required.
const configured = Widget.new({ id: "w1", tag: "t", label: "hello" })

// 'label' may be omitted (optional); the required fields are still enforced.
const minimal = Widget.new({ id: "w2", tag: "t2" })

void [ configured.label, minimal.label ]

// @ts-expect-error 'label' is typed by the setter — a number is rejected.
Widget.new({ id: "w3", tag: "t3", label: 42 })
`

async function build(compilerOptions: Record<string, unknown> | undefined): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions,
        sourceFiles            : [ { fileName : "source.ts", text } ]
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

// Same consumer + mixin without any `.new(...)` call, so declarations emit cleanly and the
// generated `WidgetConfig` alias can be inspected directly.
const configInspectionText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Labelled {
    public backing?: string

    public get label(): string {
        return this.backing ?? ""
    }

    public set label(value: string) {
        this.backing = value
    }
}

export class Widget extends Base implements Labelled {
    public id: string = ""
}
`

async function readConfigAlias(): Promise<string> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration : true },
        sourceFiles            : [ { fileName : "source.ts", text : configInspectionText } ]
    })

    try {
        await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        return await readFile(path.join(fixture.directory, "dist", "source.d.ts"), "utf8")
    } finally {
        await fixture.dispose()
    }
}

it("aggregates a mixin's settable accessor into the consumer's .new config", async (t: Test) => {
    const emit       = await build(undefined)
    const sourceView = await build({ noEmit : true })

    t.equal(emit.exitCode, 0,
        `A mixin's settable accessor is part of the consumer's .new config (emit).\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0,
        `A mixin's settable accessor is part of the consumer's .new config (source-view).\n${commandOutput(sourceView)}`)

    const dts = await readConfigAlias()

    // The mixin's settable accessor is emitted as an explicit `label?: string` config
    // member (typed by the setter), not folded into the data-field `Pick<...>`.
    t.match(dts, "label?: string",
        `the consumer config alias carries the mixin's settable accessor.\n--- source.d.ts ---\n${dts}`)
})
