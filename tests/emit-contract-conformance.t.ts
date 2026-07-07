import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { CommandResult, TypeScriptFixture } from "./util.js"

// A `@mixin` class that `implements` a contract but is *missing* a required member must
// be flagged by `tsc` (emit), not only by `tsc --noEmit` / the IDE (source view).
//
// The emit path lowers the mixin to a value cast `const X = defineMixinClass(...) as
// unknown as <type>`. The `as unknown as` double-cast erases the structural check
// between the runtime mixin body and the `implements` contract, and the generated
// `interface X extends Contract` *inherits* the contract's members instead of checking
// the class against them — so `tsc` stayed green while the IDE reported the violation
// (the documented "coverage gap"). The fix puts the mixin's `implements` clause on the
// factory's inner runtime class (`class __X$class extends base implements Contract {…}`),
// which is type-only (erased in JS) but makes the checker verify the real body. It works
// uniformly for generic and non-generic mixins, and lands the same TS2420 the IDE does,
// on the same source line.

async function runBoth(text: string): Promise<{ emit: CommandResult, ide: CommandResult, fixture: TypeScriptFixture }> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })
    const tsc     = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

    const emit = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile ], fixture.directory)
    const ide  = await runCommand("node", [ tsc, "-p", fixture.tsconfigFile, "--noEmit" ], fixture.directory)

    return { emit, ide, fixture }
}

// The source line of any diagnostic whose (possibly multi-line) message names the missing
// contract member. The member name lands on an indented continuation line (`Property
// 'greet' is missing…`), so the whole diagnostic block is captured.
function missingMemberDiagnosticLine(result: CommandResult, member: string): number | undefined {
    const output = commandOutput(result)

    for (const match of output.matchAll(/source\.ts\((\d+),\d+\): error TS\d+:[^\n]*(?:\n\s+[^\n]*)*/g)) {
        if (match[0].includes(`'${member}'`)) {
            return Number(match[1])
        }
    }

    return undefined
}

const nonGenericMissing = `import { mixin } from "ts-mixin-class"

export interface Greeter {
    greet(): string
}

@mixin()
export class GreeterMixin implements Greeter {
    name: string = "world"
}
`

const genericMissing = `import { mixin } from "ts-mixin-class"

export interface Container<T> {
    get(): T
    describe(): string
}

@mixin()
export class Box<T> implements Container<T> {
    item!: T
    get(): T { return this.item }
}
`

const genericSatisfied = `import { mixin } from "ts-mixin-class"

export interface Container<T> {
    get(): T
    describe(): string
}

@mixin()
export class Box<T> implements Container<T> {
    item!: T
    get(): T { return this.item }
    describe(): string { return "box" }
}
`

it("emit (tsc) flags a non-generic mixin that does not satisfy its implements contract", async (t: Test) => {
    const classLine              = nonGenericMissing.split("\n").findIndex((line) => line.includes("class GreeterMixin")) + 1
    const { emit, ide, fixture } = await runBoth(nonGenericMissing)

    try {
        t.equal(
            missingMemberDiagnosticLine(ide, "greet"),
            classLine,
            `source-view (--noEmit) should flag the missing 'greet' member on line ${classLine}\n${commandOutput(ide)}`
        )
        t.equal(
            missingMemberDiagnosticLine(emit, "greet"),
            classLine,
            `emit (tsc) should also flag the missing 'greet' member on line ${classLine}, not stay silent\n${commandOutput(emit)}`
        )
    } finally {
        await fixture.dispose()
    }
})

it("emit (tsc) flags a GENERIC mixin that does not satisfy its implements contract", async (t: Test) => {
    const classLine              = genericMissing.split("\n").findIndex((line) => line.includes("class Box")) + 1
    const { emit, ide, fixture } = await runBoth(genericMissing)

    try {
        t.equal(
            missingMemberDiagnosticLine(ide, "describe"),
            classLine,
            `source-view (--noEmit) should flag the missing 'describe' member on line ${classLine}\n${commandOutput(ide)}`
        )
        t.equal(
            missingMemberDiagnosticLine(emit, "describe"),
            classLine,
            `emit (tsc) should also flag the missing 'describe' member on line ${classLine} for a generic mixin, ` +
                `not stay silent\n${commandOutput(emit)}`
        )
    } finally {
        await fixture.dispose()
    }
})

it("emit (tsc) does NOT flag a mixin that does satisfy its implements contract", async (t: Test) => {
    const { emit, fixture } = await runBoth(genericSatisfied)

    try {
        t.notMatch(
            commandOutput(emit),
            /error TS/,
            `emit (tsc) should be clean for a mixin that satisfies its contract (no false positive)\n${commandOutput(emit)}`
        )
    } finally {
        await fixture.dispose()
    }
})
