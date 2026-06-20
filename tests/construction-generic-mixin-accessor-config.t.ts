import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult } from "./util.js"

// §7.5d × §7.5e × §6: a MIXIN's GENERIC settable accessor whose getter and setter types
// DIFFER and both depend on the mixin's type parameter `T` (`get value(): T`,
// `set value(input: T | string)`), flowing into a construction CONSUMER that fixes `T`.
//
// The consumer's `.new` config key for `value` must be typed by the SETTER parameter type
// with `T` SUBSTITUTED to the consumer's argument — here `Boxed<number>`, so
// `value?: number | string`. The failure modes this pins:
//   - a dangling `T` (the setter's type node cloned without substitution → `T` is unbound),
//   - the GETTER type `number` (a `Pick`-fallback), which would reject the string below.
const text = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Boxed<T> {
    public backing?: T | string

    public get value(): T {
        return this.backing as T
    }

    public set value(input: T | string) {
        this.backing = input
    }
}

class Box extends Base implements Boxed<number> {
    public id: string = ""
}

// 'value' is typed by the setter with T = number => 'number | string': BOTH compile.
const withString = Box.new({ id: "b1", value: "hello" })
const withNumber = Box.new({ id: "b2", value: 7 })

// 'value' is optional (settable accessor); the required own field is still enforced.
const minimal = Box.new({ id: "b3" })

void [ withString.value, withNumber.value, minimal.value ]

// @ts-expect-error the setter accepts number | string; a boolean is rejected.
Box.new({ id: "b4", value: true })
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
// generated `BoxConfig` alias can be inspected directly.
const configInspectionText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Boxed<T> {
    public backing?: T | string

    public get value(): T {
        return this.backing as T
    }

    public set value(input: T | string) {
        this.backing = input
    }
}

export class Box extends Base implements Boxed<number> {
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

// A consumer that FORWARDS its own type parameter to the mixin (`class Box<U> ... implements
// Boxed<U>`): the substitution maps the mixin's `T` -> the consumer's `U`, which is in scope
// in the generic `BoxConfig<U>` alias, so `value?: U | string` is well-formed (not a dangling
// `T`). Guards the substitution's type-reference (forwarding) branch, distinct from the
// concrete-argument branch above.
const forwardingInspectionText = `
import { Base } from "ts-mixin-class/base"
import { mixin } from "ts-mixin-class"

@mixin()
class Boxed<T> {
    public backing?: T | string

    public get value(): T {
        return this.backing as T
    }

    public set value(input: T | string) {
        this.backing = input
    }
}

export class Box<U> extends Base implements Boxed<U> {
    public id: string = ""
}
`

async function readForwardingConfigAlias(): Promise<string> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration : true },
        sourceFiles            : [ { fileName : "source.ts", text : forwardingInspectionText } ]
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

it("types a mixin's generic split accessor in the consumer's .new config by the substituted setter type", async (t: Test) => {
    const emit       = await build(undefined)
    const sourceView = await build({ noEmit : true })

    t.equal(emit.exitCode, 0,
        `A mixin's generic split accessor flows into the consumer .new config typed by the setter (emit).\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0,
        `A mixin's generic split accessor flows into the consumer .new config typed by the setter (source-view).\n${commandOutput(sourceView)}`)

    const dts = await readConfigAlias()

    // The setter type `T | string` is substituted to the consumer's argument: `number | string`.
    t.match(dts, "value?: number | string",
        `the consumer config alias types the mixin's generic split accessor by the substituted setter type.\n--- source.d.ts ---\n${dts}`)
})

it("forwards the consumer's own type parameter into the mixin's generic split accessor config", async (t: Test) => {
    const dts = await readForwardingConfigAlias()

    // The mixin's `T` is substituted to the consumer's forwarded `U`, in scope in `BoxConfig<U>`.
    t.match(dts, "value?: U | string",
        `the generic consumer config alias forwards its own type parameter into the accessor type.\n--- source.d.ts ---\n${dts}`)
})
