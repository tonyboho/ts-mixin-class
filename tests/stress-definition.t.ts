import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture } from "./util.js"
import { openTsServerSession } from "./tsserver-util.js"
import { loadCorpus } from "./stress/corpus.js"
import { runStressAsync } from "./stress/budget.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"
import { collectIdentifierSites, sameLineOffset } from "./stress/symbols.js"
import type { LineOffset, SymbolSite } from "./stress/symbols.js"

// Randomized stress test for language-server go-to-definition over the fixture
// corpus.
//
// We parse every fixture file, enumerate every identifier occurrence and its
// exact source span, then repeatedly ask tsserver for the definition at a random
// symbol. Two things must hold for every symbol:
//   1. the request succeeds — no server error / exception (the transform must not
//      crash the language service when a navigated symbol's declaration chain
//      walks into a generated node — this is the family that crashed on
//      `new Box<…>()`), and
//   2. `definitionAndBoundSpan` reports the *bound span* — the span of the token
//      at the request position — exactly on the queried identifier. The
//      source-view transform is position-preserving, so clicking a symbol must
//      resolve to that symbol's own span, never a widened or shifted one. (This
//      is the go-to-definition analogue of the quickinfo span check.)
//
// We deliberately do NOT require a non-empty `definitions` list: some identifiers
// legitimately have no navigation target (`undefined` in a rewritten initializer,
// a base name whose `extends` the transform rewrote), so the count of symbols
// with and without targets is reported but not asserted.
//
// All randomness comes from one seed, logged into the assertion, so a failure is
// reproducible with `MIXIN_STRESS_SEED=<seed>`.

type SiteWithFile = SymbolSite & { file: string }
type DefinitionAndBoundSpanBody = {
    definitions? : unknown[],
    textSpan?    : { start: LineOffset, end: LineOffset }
}

it("tsserver go-to-definition succeeds on every fixture symbol with the bound span exactly on it", async (t: Test) => {
    const seed   = resolveSeed()
    const random = new SeededRandom(seed)
    const corpus = loadCorpus()

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : corpus.map((file) => ({ fileName : file.fileName, text : file.text }))
    })

    const sites: SiteWithFile[] = corpus.flatMap((file) => {
        const absolutePath = fixture.sourceFiles.get(file.fileName)!

        return collectIdentifierSites(file).map((site) => ({ ...site, file : absolutePath }))
    })

    const session = openTsServerSession(fixture.directory)

    try {
        for (const file of corpus) {
            await session.open(fixture.sourceFiles.get(file.fileName)!, file.text)
        }

        let failure: string | undefined
        let withTargets    = 0
        let withoutTargets = 0
        let spanChecks     = 0

        const describe = (site: SiteWithFile): string =>
            `${site.fileName} symbol ${JSON.stringify(site.name)} ` +
            `at ${site.start.line}:${site.start.offset}-${site.end.line}:${site.end.offset}`

        const probe = async (site: SiteWithFile): Promise<void> => {
            let response

            try {
                response = await session.request("definitionAndBoundSpan", {
                    file   : site.file,
                    line   : site.query.line,
                    offset : site.query.offset
                })
            } catch (error) {
                failure = [
                    "Definition request threw during symbol stress.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `error: ${(error as Error).message}`
                ].join("\n")

                return
            }

            if (response.success === false) {
                failure = [
                    "Definition failed on a fixture symbol.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `server message: ${response.message ?? "<none>"}`
                ].join("\n")

                return
            }

            const body = response.body as DefinitionAndBoundSpanBody | undefined

            if ((body?.definitions?.length ?? 0) > 0) {
                withTargets++
            } else {
                withoutTargets++
            }

            const boundSpan = body?.textSpan

            if (boundSpan === undefined) {
                return
            }

            if (!sameLineOffset(boundSpan.start, site.start) || !sameLineOffset(boundSpan.end, site.end)) {
                failure = [
                    "Definition bound span did not land exactly on the symbol.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `bound span: ${boundSpan.start.line}:${boundSpan.start.offset}-${boundSpan.end.line}:${boundSpan.end.offset}`
                ].join("\n")

                return
            }

            spanChecks++
        }

        const iterations = await runStressAsync(
            sites,
            () => random.pick(sites),
            probe,
            () => failure !== undefined
        )

        if (failure !== undefined) {
            t.fail(failure)

            return
        }

        t.pass(
            `Ran ${iterations} definition requests (${withTargets} with targets, ${withoutTargets} without, ` +
                `${spanChecks} bound-span-checked) over ${sites.length} symbols in ${corpus.length} files, ` +
                `seed=${seed}, all bound spans exact.`
        )
    } finally {
        await session.close()
        await fixture.dispose()
    }
})
