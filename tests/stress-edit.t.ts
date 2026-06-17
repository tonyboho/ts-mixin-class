import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { transformSourceFile } from "../src/index.js"
import { loadCorpus } from "./stress/corpus.js"
import { runWithinBudget } from "./stress/budget.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"

// Randomized stress test for the program transform under editor-like editing.
//
// For a random fixture file, at a random position, we make a two-step
// round-trip edit — either insert some characters then delete them, or delete
// some characters then put them back — re-parsing incrementally with
// `ts.updateSourceFile` exactly as tsserver does on each keystroke, and run the
// transform after EVERY intermediate (often half-typed, syntactically invalid)
// state. The transform must never throw on these transient states; if it does,
// a malformed-AST exception crashes the whole program build in tsserver and the
// editor silently falls back to the untransformed program (see the
// `mixin-extends-typing-crash` regression).
//
// All randomness comes from one seed, logged into the assertion, so any failure
// is reproducible with `MIXIN_STRESS_SEED=<seed>`.

type Buffer = {
    text       : string,
    sourceFile : ts.SourceFile
}

// Fragments biased toward syntactically interesting tokens so inserts reach
// transient parser states (half-typed `extends`, stray braces/angles, etc.).
const insertFragments = [
    " ", "\n", "{", "}", "(", ")", "<", ">", "[", "]", ",", ".", ";", ":", "?", "=",
    "extends ", "implements ", "extends Base", "implements Foo", "Base", "@mixin()",
    "class ", "public ", "static ", "private ", "new ", "x", "foo", "T", "string", "number"
]

const recentWindow = 15

it("transform survives randomized editor-like edits across the fixture corpus", async (t: Test) => {
    const seed   = resolveSeed()
    const random = new SeededRandom(seed)
    const corpus = loadCorpus()

    // One live, incrementally-updated buffer per file. Each edit round-trips, so
    // a buffer's text returns to the original between visits while its SourceFile
    // accumulates real incremental-parse history across iterations.
    const buffers = new Map<string, Buffer>(corpus.map((file) => [
        file.fileName,
        {
            text       : file.text,
            sourceFile : ts.createSourceFile(file.fileName, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        }
    ]))

    const recentActions: string[] = []
    let transformCalls            = 0
    let failure: string | undefined

    const fail = (message: string): void => {
        failure = message
    }

    const apply = (buffer: Buffer, start: number, removeLength: number, insertText: string, nextText: string): void => {
        const range = ts.createTextChangeRange(ts.createTextSpan(start, removeLength), insertText.length)

        buffer.sourceFile = ts.updateSourceFile(buffer.sourceFile, nextText, range)
        buffer.text       = nextText
    }

    const runStep = (
        buffer: Buffer,
        sourceView: boolean,
        descriptor: string
    ): boolean => {
        recentActions.push(descriptor)

        if (recentActions.length > recentWindow) {
            recentActions.shift()
        }

        try {
            transformSourceFile(ts, buffer.sourceFile, sourceView ? { sourceView : true } : {})
            transformCalls++

            return true
        } catch (error) {
            fail([
                "Transform threw during randomized editor-like editing.",
                `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                `mode=${sourceView ? "sourceView" : "emit"}`,
                `error: ${(error as Error).message}`,
                `recent edit chain (oldest -> newest):\n  ${recentActions.join("\n  ")}`
            ].join("\n"))

            return false
        }
    }

    // Type `fragment` in at `position` one character at a time, transforming
    // after each keystroke, then delete it again one character at a time — the
    // real editor path. The known `extends`-typing crash only reproduced
    // character-by-character (a single bulk edit did not), so the round-trip is
    // driven keystroke-by-keystroke through every transient state.
    const insertRoundTrip = (
        buffer: Buffer,
        sourceView: boolean,
        position: number,
        fragment: string,
        label: string
    ): boolean => {
        for (let offset = 0; offset < fragment.length; offset++) {
            const character = fragment[offset]
            const at        = position + offset

            apply(buffer, at, 0, character, `${buffer.text.slice(0, at)}${character}${buffer.text.slice(at)}`)

            if (!runStep(buffer, sourceView, `${label} type ${JSON.stringify(character)} @${at}`)) {
                return false
            }
        }

        for (let offset = fragment.length - 1; offset >= 0; offset--) {
            const at = position + offset

            apply(buffer, at, 1, "", `${buffer.text.slice(0, at)}${buffer.text.slice(at + 1)}`)

            if (!runStep(buffer, sourceView, `${label} backspace @${at}`)) {
                return false
            }
        }

        return true
    }

    // Delete the span one character at a time, transforming after each, then
    // restore it character by character.
    const deleteRoundTrip = (
        buffer: Buffer,
        sourceView: boolean,
        position: number,
        removed: string,
        label: string
    ): boolean => {
        for (let count = 0; count < removed.length; count++) {
            apply(buffer, position, 1, "", `${buffer.text.slice(0, position)}${buffer.text.slice(position + 1)}`)

            if (!runStep(buffer, sourceView, `${label} delete-char @${position}`)) {
                return false
            }
        }

        for (let offset = 0; offset < removed.length; offset++) {
            const character = removed[offset]
            const at        = position + offset

            apply(buffer, at, 0, character, `${buffer.text.slice(0, at)}${character}${buffer.text.slice(at)}`)

            if (!runStep(buffer, sourceView, `${label} restore ${JSON.stringify(character)} @${at}`)) {
                return false
            }
        }

        return true
    }

    const iterations = runWithinBudget((iteration) => {
        if (failure !== undefined) {
            return
        }

        const file        = random.pick(corpus)
        const buffer       = buffers.get(file.fileName)!
        const original     = buffer.text
        const sourceView   = random.int(0, 3) !== 0
        const insertFirst  = random.bool()

        if (insertFirst) {
            const position = random.int(0, original.length)
            const fragment = random.pick(insertFragments)
            const label    = `#${iteration} ${file.fileName} insert ${JSON.stringify(fragment)} @${position}`

            insertRoundTrip(buffer, sourceView, position, fragment, label)
        } else if (original.length > 0) {
            const position = random.int(0, original.length - 1)
            const length   = random.int(1, Math.min(12, original.length - position))
            const removed  = original.slice(position, position + length)
            const label    = `#${iteration} ${file.fileName} delete ${JSON.stringify(removed)} @${position}`

            deleteRoundTrip(buffer, sourceView, position, removed, label)
        }
    })

    if (failure !== undefined) {
        t.fail(failure)

        return
    }

    t.pass(
        `Ran ${iterations} edit round-trips (${transformCalls} transforms) over ` +
            `${corpus.length} fixture files, seed=${seed}, no throws.`
    )
})
