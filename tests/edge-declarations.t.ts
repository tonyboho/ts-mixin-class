import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { CommandResult } from "./util.js"

// USER declarations that brush against the transform's own machinery: a local class named
// `Base` (must not be confused with the package construction `Base`) and a doubled `@mixin()`
// decorator. (User bindings colliding with the injected runtime helpers cannot happen: the
// helpers are imported under reserved `__defineMixinClass__`-style local aliases.)

async function build(text: string): Promise<CommandResult> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
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

it("a LOCAL class named Base is not mistaken for the package construction Base", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        // A user's own Base — NOT the package construction opt-in.
        class Base {
            grounded: boolean = true
        }

        @mixin()
        class Movable extends Base {
            move(): string {
                return "moving"
            }
        }

        class Robot extends Base implements Movable {
        }

        const robot = new Robot()

        // A construction-misdetection would ban this direct construction (branded new).
        const grounded: boolean = robot.grounded
        const moving: string    = robot.move()

        void [ grounded, moving ]
    `))

    t.equal(result.exitCode, 0,
        `a local class named Base stays an ordinary required base — no construction machinery.\n${commandOutput(result)}`)
})

it("a doubled @mixin() decorator is tolerated or cleanly diagnosed, never silently broken", async (t: Test) => {
    const result = await build(trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        @mixin()
        class Greeter {
            greet(): string {
                return "hi"
            }
        }

        class Consumer implements Greeter {
        }

        const greeted: string = new Consumer().greet()

        void greeted
    `))

    // Either outcome is a coherent spec: a clean compile (the second decorator is a no-op) or
    // a native TS9900xx diagnostic. A raw crash / TS2420 soup is not.
    const output = commandOutput(result)

    if (result.exitCode === 0) {
        t.pass("a doubled @mixin() compiles as a no-op")
    } else {
        t.match(output, "TS9900", `a doubled @mixin() gets a native diagnostic, not a raw error.\n${output}`)
    }
})
