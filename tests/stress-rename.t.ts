import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture } from "./util.js"
import { openTsServerSession } from "./tsserver-util.js"
import type { RenameResponseBody } from "./tsserver-editor-util.js"
import { loadCorpus } from "./stress/corpus.js"
import { runStressAsync } from "./stress/budget.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"
import { collectIdentifierSites } from "./stress/symbols.js"
import type { SymbolSite } from "./stress/symbols.js"

// Randomized stress test for language-server rename over the fixture corpus.
//
// We parse every fixture file, enumerate every identifier occurrence, then
// repeatedly ask tsserver to rename a random symbol. For every symbol:
//   1. the request succeeds — no server error / exception, and
//   2. when the symbol is renameable (`canRename`), the rename actually
//      completes: tsserver returns at least one rename location. (A symbol that
//      legitimately cannot be renamed — e.g. one resolving into a dependency —
//      returns `canRename: false`, which is fine.)
//
// All randomness comes from one seed, logged into the assertion, so a failure is
// reproducible with `MIXIN_STRESS_SEED=<seed>`.

type SiteWithFile = SymbolSite & { file: string }

it("tsserver rename succeeds on every fixture symbol and finds locations when renameable", async (t: Test) => {
    const seed   = resolveSeed()
    const random = new SeededRandom(seed)
    const corpus = loadCorpus()

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : corpus.map((file) => ({ fileName: file.fileName, text: file.text }))
    })

    const sites: SiteWithFile[] = corpus.flatMap((file) => {
        const absolutePath = fixture.sourceFiles.get(file.fileName)!

        return collectIdentifierSites(file).map((site) => ({ ...site, file: absolutePath }))
    })

    const session = openTsServerSession(fixture.directory)

    try {
        for (const file of corpus) {
            await session.open(fixture.sourceFiles.get(file.fileName)!, file.text)
        }

        let failure: string | undefined
        let renameable    = 0
        let notRenameable = 0

        const describe = (site: SiteWithFile): string =>
            `${site.fileName} symbol ${JSON.stringify(site.name)} at ${site.start.line}:${site.start.offset}`

        const probe = async (site: SiteWithFile): Promise<void> => {
            let response

            try {
                response = await session.request("rename", {
                    file   : site.file,
                    line   : site.query.line,
                    offset : site.query.offset
                })
            } catch (error) {
                failure = [
                    "Rename request threw during symbol stress.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `error: ${(error as Error).message}`
                ].join("\n")

                return
            }

            if (response.success === false) {
                failure = [
                    "Rename failed on a fixture symbol.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `server message: ${response.message ?? "<none>"}`
                ].join("\n")

                return
            }

            const body = response.body as RenameResponseBody | undefined

            if (body?.info?.canRename !== true) {
                notRenameable++

                return
            }

            const locationCount = (body.locs ?? []).reduce((sum, location) => sum + location.locs.length, 0)

            if (locationCount === 0) {
                failure = [
                    "Rename reported the symbol as renameable but returned no locations.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `displayName: ${body.info.displayName ?? "<none>"}`
                ].join("\n")

                return
            }

            renameable++
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
            `Ran ${iterations} rename requests (${renameable} renameable with locations, ` +
                `${notRenameable} not renameable) over ${sites.length} symbols in ${corpus.length} files, ` +
                `seed=${seed}, all succeeded.`
        )
    } finally {
        await session.close()
        await fixture.dispose()
    }
})
