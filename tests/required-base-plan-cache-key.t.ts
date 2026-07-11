import path from "node:path"
// The temp directory is intentionally left behind (OS temp cleanup owns it) — the same
// convention as the fixture tests that keep their directory alive for dynamic imports.
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { defaultTransformOptions } from "../src/model.js"
import { buildMixinRegistry } from "../src/registry.js"
import { buildRequiredBaseContext } from "../src/required-base-plan.js"

// 2026-07 review finding 4: the required-base part of the transform cache key must be
// SHAPE-based, like registryCacheKey — a position-shifting edit (a comment above a
// mixin) must not change it, or every cached transformed file in the program misses
// on each such keystroke.

const mixinSource = `
import { mixin } from "ts-mixin-class"

class RootBase {
    root(): string { return "root" }
}

class SpecificBase extends RootBase {
    specific(): string { return "specific" }
}

@mixin()
export class NeedsSpecific extends SpecificBase {
}
`

// One shared directory: the cache key legitimately contains the mixin's FILE PATH, so
// both program variants must live at the same path for the comparison to isolate the
// position (in)dependence.
const directory = mkdtempSync(path.join(tmpdir(), "ts-mixin-cache-key-"))

function contextCacheKey(text: string): string {
    const fileName = path.join(directory, "mixins.ts")

    writeFileSync(fileName, text)

    const program  = ts.createProgram([ fileName ], { target: ts.ScriptTarget.ES2022, strict: true })
    const registry = buildMixinRegistry(ts, program, defaultTransformOptions, () => undefined)

    return buildRequiredBaseContext(ts, program, registry, defaultTransformOptions).cacheKey
}

it("the required-base cache key survives position-shifting edits", async (t: Test) => {
    const original = contextCacheKey(mixinSource)
    const shifted  = contextCacheKey(`// a comment that shifts every declaration position\n\n${mixinSource}`)

    t.true(original.length > 0, "constraints produce a non-empty cache key")
    t.equal(shifted, original, "a leading comment does not invalidate the program-wide transform cache")
})

it("the required-base cache key reflects a changed base ancestry", async (t: Test) => {
    const original = contextCacheKey(mixinSource)
    const rebased  = contextCacheKey(mixinSource.replace(
        "class SpecificBase extends RootBase {",
        "class SpecificBase {"
    ))

    t.ne(rebased, original, "detaching the base's ancestor changes the key (consumers must re-transform)")
})
