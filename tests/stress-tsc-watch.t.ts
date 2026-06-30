import { writeFile } from "node:fs/promises"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { createTypeScriptFixture, requiredFixtureSourceFile } from "./util.js"
import { errorCount, startTscWatch } from "./tsc-watch-util.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"

// Randomized round-trip stress for the transformer under a REAL `tsc --watch` (the end-to-end
// analogue of the in-process `stress-edit`). For a random fixture file we apply ONE minimal,
// randomly-chosen edit — delete a character of an identifier, insert a character into an
// identifier, delete a bracket, or insert a stray bracket — each of which, over this densely
// cross-referenced fixture, reliably breaks compilation. We then assert the watch rebuild reports
// SOME error (we do not care which), restore the file verbatim, and assert the watch rebuild
// returns to zero errors. The break proves the rebuild re-ran the transform against the edited
// source; the recovery proves it did not serve a stale program.
//
// Edit sites come from the parsed AST (identifiers) and a raw scan for brackets, so an edit never
// lands in whitespace. The fixture deliberately keeps brackets out of its string/comment literals,
// so a raw bracket scan only hits real code.
//
// All randomness comes from one seed, printed into every assertion, so a failure is reproducible
// with `MIXIN_STRESS_SEED=<seed>`. The edit count defaults small (real rebuilds are not free) and
// is overridable with `MIXIN_WATCH_STRESS_EDITS=<n>` for a heavier local run.

// A small clean fixture: two mixins (Beta depends on Alpha), a consumer using both, and a
// construction class. Every declared name is referenced elsewhere, so any minimal edit breaks a
// declaration or a use — i.e. an edit reliably produces a diagnostic. Keep brackets out of the
// string literals here (the bracket scan assumes it only sees real code).
const fixtureSources: { fileName: string, text: string }[] = [
    {
        fileName : "mixin-a.ts",
        text     : `
            import { mixin } from "ts-mixin-class"

            @mixin()
            export class Alpha {
                alphaValue(): number {
                    return 1
                }
            }
        `
    },
    {
        fileName : "mixin-b.ts",
        text     : `
            import { mixin } from "ts-mixin-class"
            import { Alpha } from "./mixin-a.js"

            @mixin()
            export class Beta implements Alpha {
                betaValue(): number {
                    return this.alphaValue() + 1
                }
            }
        `
    },
    {
        fileName : "consumer.ts",
        text     : `
            import { Beta } from "./mixin-b.js"

            class Consumer implements Beta {
            }

            const consumer = new Consumer()

            void consumer.alphaValue()
            void consumer.betaValue()
        `
    },
    {
        fileName : "construction.ts",
        text     : `
            import { Base } from "ts-mixin-class/base"

            class Account extends Base {
                public id!: string
            }

            const account = Account.new({ id: "account-1" })

            void account.id
        `
    }
]

const brackets = [ "{", "}", "(", ")", "[", "]" ]
const letters  = "abcdefghijklmnopqrstuvwxyz"

function editCount(): number {
    const fromEnvironment = process.env.MIXIN_WATCH_STRESS_EDITS

    if (fromEnvironment !== undefined && fromEnvironment.trim() !== "") {
        const parsed = Number.parseInt(fromEnvironment, 10)

        if (!Number.isNaN(parsed) && parsed > 0) {
            return parsed
        }
    }

    return 8
}

// Byte ranges of identifier tokens (length >= 2 so a one-char deletion still leaves a real,
// renamed identifier rather than empty/invalid syntax), read from the parsed AST.
function identifierRanges(fileName: string, text: string): { start: number, length: number }[] {
    const sourceFile                                  = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const ranges: { start: number, length: number }[] = []

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            const start  = node.getStart(sourceFile)
            const length = node.getEnd() - start

            if (length >= 2) {
                ranges.push({ start, length })
            }
        }

        ts.forEachChild(node, visit)
    }

    sourceFile.forEachChild(visit)

    return ranges
}

// Positions of bracket characters. Safe as a raw scan because the fixture keeps brackets out of
// its string/comment literals (see the note above), so every hit is real code.
function bracketPositions(text: string): number[] {
    const positions: number[] = []

    for (let index = 0; index < text.length; index++) {
        if (brackets.includes(text[index])) {
            positions.push(index)
        }
    }

    return positions
}

type Edit = {
    broken     : string,
    descriptor : string
}

// One random minimal edit that breaks compilation. `remove` deletes the char at a position;
// `insert` adds a char before it — both are reverted by simply restoring the original text.
function makeEdit(random: SeededRandom, fileName: string, original: string): Edit {
    const identifiers = identifierRanges(fileName, original)
    const identifier  = random.pick(identifiers)
    const remove      = (position: number, what: string): Edit => ({
        broken     : `${original.slice(0, position)}${original.slice(position + 1)}`,
        descriptor : `${fileName} delete ${what} ${JSON.stringify(original[position])} @${position}`
    })
    const insert      = (position: number, character: string, what: string): Edit => ({
        broken     : `${original.slice(0, position)}${character}${original.slice(position)}`,
        descriptor : `${fileName} insert ${what} ${JSON.stringify(character)} @${position}`
    })

    switch (random.int(0, 3)) {
        case 0  : return remove(identifier.start + random.below(identifier.length), "identifier char")
        case 1  : return insert(identifier.start + random.below(identifier.length), letters[random.below(letters.length)], "identifier char")
        case 2  : return remove(random.pick(bracketPositions(original)), "bracket")
        default : return insert(identifier.start, random.pick(brackets), "stray bracket")
    }
}

it("survives randomized minimal edits across tsc --watch rebuilds", async (t: Test) => {
    const seed   = resolveSeed()
    const random = new SeededRandom(seed)
    const edits  = editCount()

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { noEmit: true },
        sourceFiles            : fixtureSources
    })

    // The pristine text of each file, by absolute path — what every edit is reverted to.
    const originalText = new Map(fixtureSources.map(({ fileName, text }) =>
        [ requiredFixtureSourceFile(fixture.sourceFiles, fileName), text ]))

    const watch = startTscWatch(fixture.directory, fixture.tsconfigFile)
    let   failure: string | undefined

    const reproduce = `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm --filter ts-mixin-class run test)`

    try {
        const baseline = await watch.waitForBuild()

        t.is(errorCount(baseline), 0, `Baseline watch build is clean (${reproduce})`)

        for (let iteration = 0; iteration < edits && failure === undefined; iteration++) {
            const source   = random.pick(fixtureSources)
            const filePath = requiredFixtureSourceFile(fixture.sourceFiles, source.fileName)
            const original = originalText.get(filePath)!
            const edit     = makeEdit(random, source.fileName, original)

            // Break: apply the edit; the next rebuild must report an error.
            await writeFile(filePath, edit.broken)

            const afterBreak = errorCount(await watch.waitForBuild())

            if (afterBreak < 1) {
                failure = [
                    "A minimal edit did NOT produce an error on the watch rebuild.",
                    reproduce,
                    `edit #${iteration}: ${edit.descriptor}`
                ].join("\n")
            }

            // Recover: restore the file verbatim; the next rebuild must return to zero errors.
            await writeFile(filePath, original)

            const afterRevert = errorCount(await watch.waitForBuild())

            if (failure === undefined && afterRevert !== 0) {
                failure = [
                    "Reverting a minimal edit did NOT return the watch build to zero errors.",
                    reproduce,
                    `edit #${iteration}: ${edit.descriptor}  ->  reverted, but ${afterRevert} error(s) remained`
                ].join("\n")
            }
        }
    } finally {
        watch.dispose()
        await fixture.dispose()
    }

    if (failure !== undefined) {
        t.fail(failure)

        return
    }

    t.pass(`Ran ${edits} break/revert round-trips under tsc --watch, seed=${seed}, every break surfaced and every revert cleared.`)
})
