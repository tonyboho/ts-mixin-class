import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// PARTIAL accessor overrides across the mixin chain (TS990011). JS prototype shadowing is
// per-NAME, not per-half: a nearer accessor descriptor replaces the deeper one ENTIRELY, so an
// override that declares fewer halves than the overridden accessor silently kills the missing
// half at runtime (dead setter → strict-mode TypeError on write; dead getter → undefined reads)
// while the merged TYPE still looks whole. Plain TypeScript is silent on every such shape even
// in an ordinary extends chain — but there the user WROTE the chain; a mixin chain is implicit,
// so the transform rejects narrowing with a native diagnostic. The rule: an override's half-set
// must be a SUPERSET of the overridden one — extending (adding a half) is fine, narrowing is an
// error. Unlike TS990010 the hazard does not depend on define/set semantics. Checked layers:
// mixin layers only (a consumer's own `extends` base is plain-TS territory and stays silent).

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

async function buildBothPlanes(text: string): Promise<{ emit: CommandResult, sourceView: CommandResult }> {
    const [ emit, sourceView ] = await Promise.all([ build(text), build(text, { noEmit: true }) ])

    return { emit, sourceView }
}

function assertRejectedBothPlanes(
    t: Test,
    planes: { emit: CommandResult, sourceView: CommandResult },
    messageParts: string[]
): void {
    const emitOutput = commandOutput(planes.emit)

    t.ne(planes.emit.exitCode, 0, "emit: rejected")
    t.match(emitOutput, "TS990011", `a native partial-accessor-override diagnostic.\n${emitOutput}`)

    for (const part of messageParts) {
        t.match(emitOutput, part, `the message explains: ${part}`)
    }

    const sourceViewOutput = commandOutput(planes.sourceView)

    t.ne(planes.sourceView.exitCode, 0, "source view: rejected identically")
    t.match(sourceViewOutput, "TS990011", `both planes agree.\n${sourceViewOutput}`)
}

it("a consumer's GET-ONLY accessor over a mixin's full pair is rejected — the setter would die", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Pair {
            public stored: number = 10

            get x(): number {
                return this.stored
            }

            set x(value: number) {
                this.stored = value
            }
        }

        class GetOnlyUser implements Pair {
            override get x(): number {
                return 42
            }
        }

        void GetOnlyUser
    `))

    assertRejectedBothPlanes(t, planes, [ "get/set pair in mixin Pair", "set accessor" ])
})

it("a consumer's SET-ONLY accessor over a mixin's full pair is rejected — the getter would die", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Pair {
            public stored: number = 10

            get x(): number {
                return this.stored
            }

            set x(value: number) {
                this.stored = value
            }
        }

        class SetOnlyUser implements Pair {
            override set x(value: number) {
                void value
            }
        }

        void SetOnlyUser
    `))

    assertRejectedBothPlanes(t, planes, [ "get/set pair in mixin Pair", "get accessor" ])
})

it("'adding the missing half' — a consumer's SET-ONLY over a mixin's GET-ONLY is rejected", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class GetOnlyMixin {
            get label(): string {
                return "from-mixin"
            }
        }

        class AddSetUser implements GetOnlyMixin {
            override set label(value: string) {
                void value
            }
        }

        void AddSetUser
    `))

    assertRejectedBothPlanes(t, planes, [ "get accessor in mixin GetOnlyMixin" ])
})

it("mixin-vs-mixin in ONE implements list: a nearer half over a deeper pair is rejected", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class HalfSet {
            set shared(value: number) {
                void value
            }
        }

        @mixin()
        class FullShared {
            public v: number = 7

            get shared(): number {
                return this.v
            }

            set shared(value: number) {
                this.v = value
            }
        }

        class TwoMixinUser implements HalfSet, FullShared {
        }

        void TwoMixinUser
    `))

    assertRejectedBothPlanes(t, planes, [ "mixin HalfSet", "nearer layer" ])
})

it("a consumer's half-override over a mixin's AUTO-ACCESSOR is rejected", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class AutoMixin {
            accessor slot: number = 5
        }

        class HalfOverAuto implements AutoMixin {
            override get slot(): number {
                return 99
            }
        }

        void HalfOverAuto
    `))

    assertRejectedBothPlanes(t, planes, [ "auto-accessor", "mixin AutoMixin" ])
})

it("a MIXIN narrowing its DEPENDENCY's accessor pair is rejected at the mixin's own declaration", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Pair {
            public stored: number = 1

            get x(): number {
                return this.stored
            }

            set x(value: number) {
                this.stored = value
            }
        }

        @mixin()
        class Narrowing implements Pair {
            override get x(): number {
                return 0
            }
        }

        void Narrowing
    `))

    assertRejectedBothPlanes(t, planes, [ "get/set pair in mixin Pair", "Narrowing" ])
})

it("a consumer narrowing a TRANSITIVE dependency's accessor is rejected (through the linearized chain)", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Pair {
            public stored: number = 1

            get x(): number {
                return this.stored
            }

            set x(value: number) {
                this.stored = value
            }
        }

        @mixin()
        class Middle implements Pair {
            middle(): string {
                return "middle"
            }
        }

        class DeepUser implements Middle {
            override set x(value: number) {
                void value
            }
        }

        void DeepUser
    `))

    assertRejectedBothPlanes(t, planes, [ "get/set pair in mixin Pair" ])
})

it("EXTENDING is allowed: a consumer's full pair over a mixin's get-only, and same-half overrides", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class GetOnlyMixin {
            get label(): string {
                return "from-mixin"
            }
        }

        // extension: adds the setter while keeping a getter — nothing dies
        class ExtendingUser implements GetOnlyMixin {
            public backing: string = "own"

            override get label(): string {
                return this.backing
            }

            override set label(value: string) {
                this.backing = value
            }
        }

        // same half over the same half — a normal full replacement
        class SameHalfUser implements GetOnlyMixin {
            override get label(): string {
                return "replaced"
            }
        }

        @mixin()
        class PairMixin {
            public stored: number = 3

            get x(): number {
                return this.stored
            }

            set x(value: number) {
                this.stored = value
            }
        }

        // full pair over full pair — a normal override
        class FullOverFull implements PairMixin {
            public own: number = 0

            override get x(): number {
                return this.own
            }

            override set x(value: number) {
                this.own = value
            }
        }

        // an AUTO-ACCESSOR over a get-only — carries both halves, a superset
        class AutoOverGet implements GetOnlyMixin {
            override accessor label: string = "auto"
        }

        void [ ExtendingUser, SameHalfUser, FullOverFull, AutoOverGet ]
    `))

    t.equal(planes.emit.exitCode, 0, `emit: extensions compile.\n${commandOutput(planes.emit)}`)
    t.equal(planes.sourceView.exitCode, 0, `source view agrees.\n${commandOutput(planes.sourceView)}`)
})

it("a REQUIRED-BASE / plain-extends accessor override stays plain-TS territory — no TS990011", async (t: Test) => {
    const planes = await buildBothPlanes(trimIndent(`
        import { mixin } from "ts-mixin-class"

        class RealBase {
            public v: number = 0

            get x(): number {
                return this.v
            }

            set x(value: number) {
                this.v = value
            }
        }

        @mixin()
        class Unrelated {
            tag(): string {
                return "tag"
            }
        }

        // narrows the REAL extends base's pair — the same silent trap plain TypeScript
        // allows in any ordinary class; the guard covers mixin layers only.
        class BaseNarrowingUser extends RealBase implements Unrelated {
            override get x(): number {
                return 1
            }
        }

        void BaseNarrowingUser
    `))

    t.equal(planes.emit.exitCode, 0, `emit: plain-extends narrowing is not ours to reject.\n${commandOutput(planes.emit)}`)
    t.equal(planes.sourceView.exitCode, 0, `source view agrees.\n${commandOutput(planes.sourceView)}`)
})
