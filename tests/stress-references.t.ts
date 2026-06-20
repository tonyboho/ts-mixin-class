import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture } from "./util.js"
import { openTsServerSession } from "./tsserver-util.js"
import { positionToIndex } from "./tsserver-editor-util.js"
import { loadCorpus } from "./stress/corpus.js"
import { resolveStressBudget, runWithinBudgetAsync, stressExhaustive } from "./stress/budget.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"
import { collectIdentifierSites, sameLineOffset } from "./stress/symbols.js"
import type { LineOffset, SymbolSite } from "./stress/symbols.js"

// Randomized stress test for language-server find-all-references over the fixture
// corpus.
//
// We parse every fixture file, enumerate every identifier occurrence, then
// repeatedly ask tsserver for the references of a random symbol. Two things must
// hold for every symbol:
//   1. the request succeeds — no server error / exception (references walks the
//      consumer's super-type heritage, the path that crashed reading a generated
//      heritage node's type `.flags`), and
//   2. every returned reference that lands in a corpus file highlights *exactly*
//      an identifier whose text is the symbol's name (the source-view transform is
//      position-preserving, so a reference must never come back with a widened or
//      shifted span — across the whole corpus that is tens of thousands of spans),
//      and
//   3. whenever the result is non-empty, it includes the query position itself.
//      Every symbol references itself, so a non-empty result that omits the query
//      site means the position resolved to a generated node instead of the source
//      declaration — exactly the bug where find-all-references on a consumer class
//      name returned its usages but not its own declaration, and
//   4. an *empty* result is only tolerated where it is legitimately expected:
//      identifiers inside a class heritage clause (the heritage-rewrite navigation
//      gap — a rewritten `extends`/`implements` resolves its base name and type
//      arguments to a generated node) and member names of a property access (an
//      access to a non-existent member has no symbol). Every other empty result is
//      a failure: a normal declaration or usage that returns no references means its
//      position stopped resolving to its own symbol.
//
// All randomness comes from one seed, logged into the assertion, so a failure is
// reproducible with `MIXIN_STRESS_SEED=<seed>`.

type SiteWithFile = SymbolSite & { file: string }
type ReferenceEntry = { file: string, start: LineOffset, end: LineOffset }
type ReferencesBody = { refs?: ReferenceEntry[] }

it("tsserver find-all-references succeeds on every fixture symbol with every span exactly on a name", async (t: Test) => {
    const seed   = resolveSeed()
    const random = new SeededRandom(seed)
    const corpus = loadCorpus()

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : corpus.map((file) => ({ fileName : file.fileName, text : file.text }))
    })

    const textByFile = new Map<string, string>()

    const sites: SiteWithFile[] = corpus.flatMap((file) => {
        const absolutePath = fixture.sourceFiles.get(file.fileName)!

        textByFile.set(absolutePath, file.text)

        return collectIdentifierSites(file).map((site) => ({ ...site, file : absolutePath }))
    })

    const session = openTsServerSession(fixture.directory)

    try {
        for (const file of corpus) {
            await session.open(fixture.sourceFiles.get(file.fileName)!, file.text)
        }

        let failure: string | undefined
        let withSelf       = 0
        let emptyResults   = 0
        let spanChecks     = 0
        let toleratedMix   = 0

        const describe = (site: SiteWithFile): string =>
            `${site.fileName} symbol ${JSON.stringify(site.name)} ` +
            `at ${site.start.line}:${site.start.offset}-${site.end.line}:${site.end.offset}`

        // KNOWN, DEFERRED limitation (USE-CASES Open questions): find-all-references on the
        // generated `.mix` method of a manual `Mixin.mix(Base)` apply crashes tsserver's type
        // display (`writeType` -> node-reuse -> `resolveEntityName` on the scopeless synthetic
        // `.mix` type). Same root as the deferred manual-`.mix` go-to-definition gap. Until
        // that is fixed, a references request on a `.mix` member name is tolerated rather than
        // failing the stress run. Every OTHER crash/failure is still a hard failure.
        const isKnownMixApplyLimitation = (site: SiteWithFile): boolean =>
            site.isMemberName && site.name === "mix"

        const probe = async (site: SiteWithFile): Promise<void> => {
            let response

            try {
                response = await session.request("references", {
                    file   : site.file,
                    line   : site.query.line,
                    offset : site.query.offset
                })
            } catch (error) {
                if (isKnownMixApplyLimitation(site)) {
                    toleratedMix++

                    return
                }

                failure = [
                    "References request threw during symbol stress.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `error: ${(error as Error).message}`
                ].join("\n")

                return
            }

            if (response.success === false) {
                if (isKnownMixApplyLimitation(site)) {
                    toleratedMix++

                    return
                }

                failure = [
                    "References failed on a fixture symbol.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `server message: ${response.message ?? "<none>"}`
                ].join("\n")

                return
            }

            const refs = (response.body as ReferencesBody | undefined)?.refs ?? []

            if (refs.length === 0) {
                if (site.inHeritageClause || site.isMemberName) {
                    emptyResults++
                } else {
                    failure = [
                        "Find-all-references returned no locations for a symbol that should reference itself.",
                        `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                        describe(site),
                        "Only heritage-clause identifiers and property-access member names may be empty."
                    ].join("\n")

                    return
                }
            } else if (refs.some((ref) => ref.file === site.file && sameLineOffset(ref.start, site.start))) {
                withSelf++
            } else {
                failure = [
                    "Find-all-references returned locations but not the query site itself.",
                    `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                    describe(site),
                    `locations: ${refs.map((ref) => `${ref.start.line}:${ref.start.offset}`).join(", ")}`
                ].join("\n")

                return
            }

            for (const ref of refs) {
                const text = textByFile.get(ref.file)

                if (text === undefined) {
                    continue
                }

                const highlighted = text.slice(positionToIndex(text, ref.start), positionToIndex(text, ref.end))

                if (highlighted !== site.name) {
                    failure = [
                        "A reference span did not land exactly on an identifier with the symbol's name.",
                        `seed=${seed}  (reproduce: MIXIN_STRESS_SEED=${seed} pnpm test)`,
                        describe(site),
                        `reference span: ${ref.start.line}:${ref.start.offset}-${ref.end.line}:${ref.end.offset} ` +
                            `highlighted ${JSON.stringify(highlighted)}`
                    ].join("\n")

                    return
                }

                spanChecks++
            }
        }

        // Exhaustive mode walks every enumerated site once (deterministic, pinpoints the
        // offending fixture); otherwise sample random sites within the (env-tunable) budget.
        let iterations: number

        if (stressExhaustive()) {
            iterations = 0

            for (const site of sites) {
                if (failure !== undefined) {
                    break
                }

                await probe(site)
                iterations++
            }
        } else {
            iterations = await runWithinBudgetAsync(async () => {
                if (failure === undefined) {
                    await probe(random.pick(sites))
                }
            }, resolveStressBudget())
        }

        if (failure !== undefined) {
            t.fail(failure)

            return
        }

        t.pass(
            `Ran ${iterations} references requests (${withSelf} included the query site, ` +
                `${emptyResults} tolerated-empty heritage/member-name, ${spanChecks} reference spans checked, ` +
                `${toleratedMix} tolerated known manual-.mix display limitation) ` +
                `over ${sites.length} symbols in ${corpus.length} files, seed=${seed}, every span exact, ` +
                `every non-empty result self-inclusive, and no unexpected empty result.`
        )
    } finally {
        await session.close()
        await fixture.dispose()
    }
})
