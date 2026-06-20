import ts from "typescript"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile } from "./util.js"
import { commandOutput } from "./util.js"
import { buildConstructionSource } from "./construction-build-util.js"

// The transformer injects helper imports (`defineMixinClass`, `ClassStatics`, …) and CONSUMES
// the user's `@mixin()` decorator import. Historically it emitted a FIXED superset of helper
// specifiers and left the now-unused `mixin` import in place, so the transformed file carried
// unused imports — a hard `noUnusedLocals` (TS6133) error for any strict project. The transform
// now prunes the generated helper import down to what is actually referenced and drops the
// consumed decorator import when it is no longer used.

const source = `
import { mixin } from "ts-mixin-class"

@mixin()
class Logger {
    log(message: string): string {
        return message
    }
}

class Service implements Logger {
}

const service = new Service()

void service
`

it("transformed output compiles under noUnusedLocals (no unused generated or decorator imports)", async (t: Test) => {
    const emit       = await buildConstructionSource(source, { noUnusedLocals : true })
    const sourceView = await buildConstructionSource(source, { noUnusedLocals : true, noEmit : true })

    t.equal(emit.exitCode, 0,
        `A transformed mixin/consumer file must carry no unused imports under noUnusedLocals (emit).\n${commandOutput(emit)}`)
    t.equal(sourceView.exitCode, 0,
        `…and the same under --noEmit (source-view).\n${commandOutput(sourceView)}`)
})

it("prunes the generated helper import to only referenced helpers and drops the consumed mixin import", (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(source)))

    // This plain mixin/consumer references neither `__mixinBase` (required-base diagnostics
    // only) nor `StaticNeverConflictKeys` (statics-collision guard, no statics here), so the
    // old FIXED import list's specifiers for them are now pruned. (`MixinClassValue` IS used —
    // it is the value-cast for a non-generic mixin — and is correctly kept.)
    t.notMatch(printed, "__mixinBase", "an unused required-base helper is pruned from the generated import")
    t.notMatch(printed, "StaticNeverConflictKeys", "an unused static-collision helper is pruned from the generated import")

    // The `@mixin()` decorator is consumed, so the user's `mixin` import is dropped.
    const importsMixinBinding = printed
        .split("\n")
        .some((line) => /^import\b/.test(line) && /[{,]\s*mixin\s*[},]/.test(line))

    t.notOk(importsMixinBinding, `the consumed 'mixin' decorator import is dropped.\n--- printed ---\n${printed}`)

    // A referenced helper stays imported.
    t.match(printed, "defineMixinClass", "a referenced value helper stays imported")
})
