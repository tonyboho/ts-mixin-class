import { readFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"

// The generated `<ClassName>Config` alias is a sibling top-level statement. Its `export`
// keyword must track the class's own export status, the same way the mixin factory does
// (`exportModifiersOf`): an exported construction class exposes its config; a module-local
// class keeps the config local too, so a purely internal class does not leak `<Name>Config`
// into the module's public surface.
const text = `
import { Base } from "ts-mixin-class/base"

export class Account extends Base {
    public id!: string = ""
    public label?: string
}

class Local extends Base {
    public token!: string = ""
}

const account = Account.new({ id: "a1" })
const local = Local.new({ token: "t1" })

export const accountId = account.id
export const localToken = local.token
// Keep \`Local\` reachable from an export so its (now non-exported) declaration and config
// alias survive declaration emit and can be inspected - otherwise tsc correctly elides the
// whole internal class from the .d.ts.
export const localFactory = Local
`

it("the generated config alias is exported only when its class is exported", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })

    try {
        const result = await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        )

        t.equal(result.exitCode, 0, `both construction classes build.\n${commandOutput(result)}`)

        const declaration = await readFile(path.join(fixture.directory, "dist", "source.d.ts"), "utf8")

        // Exported class: its config is part of the public API.
        t.match(declaration, "export type AccountConfig", "exported class exports its config alias")

        // Module-local class: the alias is still generated (the `static new` references it),
        // but it is NOT exported - the internal class does not leak `LocalConfig`.
        t.match(declaration, "type LocalConfig", "local class still generates a config alias")
        t.notMatch(declaration, "export type LocalConfig", "local class does not export its config alias")

        // The local class's typed factory still resolves against the (local) alias.
        t.match(declaration, "static new(props: LocalConfig): Local", "local class keeps its typed static new")

        // Runtime is unaffected by the alias export status.
        const moduleUrl   = pathToFileURL(path.join(fixture.directory, "dist", "source.js")).href
        const constructed = await import(moduleUrl) as { accountId: string, localToken: string }

        t.equal(constructed.accountId, "a1", "exported class constructs at runtime")
        t.equal(constructed.localToken, "t1", "local class constructs at runtime")
    } finally {
        await fixture.dispose()
    }
})
