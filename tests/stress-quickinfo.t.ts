import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture } from "./util.js"
import { openTsServerSession } from "./tsserver-util.js"
import type { QuickInfoBody } from "./tsserver-editor-util.js"
import { loadCorpus } from "./stress/corpus.js"
import { runStressAsync } from "./stress/budget.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"
import { collectIdentifierSites, sameLineOffset } from "./stress/symbols.js"
import type { SymbolSite } from "./stress/symbols.js"

// Randomized stress test for language-server quickinfo over the fixture corpus.
//
// We parse every fixture file, enumerate every identifier occurrence and its
// exact source span, then repeatedly ask tsserver for quickinfo at a random
// symbol. Two things must hold for every symbol:
//   1. the request succeeds — no server error / exception (the transform must
//      not crash the language service on any symbol), and
//   2. the returned highlight span lands EXACTLY on the symbol. The source-view
//      transform is position-preserving, but a mapping bug used to make the
//      quickinfo span start before the identifier — see the regression guarded
//      by "tsserver quickinfo reports mixin consumer class declarations", which
//      checks the span starts at the class name. Here we assert it for every
//      symbol in the corpus.
//
// All randomness comes from one seed, logged into the assertion, so a failure is
// reproducible with `MIXIN_STRESS_SEED=<seed>`.

type SiteWithFile = SymbolSite & { file: string }

it("tsserver quickinfo succeeds on every fixture symbol with the highlight exactly on it", async (t: Test) => {
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
        let withInfo   = 0
        let spanChecks = 0

        const describe = (site: SiteWithFile): string =>
            `${site.fileName} symbol ${JSON.stringify(site.name)} ` +
            `at ${site.start.line}:${site.start.offset}-${site.end.line}:${site.end.offset}`

        const probe = async (site: SiteWithFile): Promise<void> => {
            let response

            try {
                response = await session.request("quickinfo", {
                    file   : site.file,
                    line   : site.query.line,
                    offset : site.query.offset
                })
            } catch (error) {
                failure = [
                    "Quickinfo request threw during symbol stress.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `error: ${(error as Error).message}`
                ].join("\n")

                return
            }

            if (response.success === false) {
                failure = [
                    "Quickinfo failed on a fixture symbol.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `server message: ${response.message ?? "<none>"}`
                ].join("\n")

                return
            }

            const body = response.body as QuickInfoBody | undefined

            if (body?.displayString === undefined) {
                return
            }

            withInfo++

            if (!sameLineOffset(body.start, site.start) || !sameLineOffset(body.end, site.end)) {
                failure = [
                    "Quickinfo highlight span did not land exactly on the symbol.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `highlight: ${body.start.line}:${body.start.offset}-${body.end.line}:${body.end.offset}`,
                    `quickinfo: ${body.displayString}`
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
            `Ran ${iterations} quickinfo requests (${withInfo} with info, ${spanChecks} span-checked) ` +
                `over ${sites.length} symbols in ${corpus.length} files, seed=${seed}, all exact.`
        )
    } finally {
        await session.close()
        await fixture.dispose()
    }
})
