import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import transformProgram from "../src/index.js"
import { runWithinBudget } from "./stress/budget.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"
import { packageRoot } from "./util.js"

// Randomized parity stress test for emit-path diagnostic remapping — and the
// reference for how the two paths differ in the diagnostics they report:
//   - emit  (`tsc` / `mode "emit"`): value-cast tree reprinted to text;
//   - IDE   (`--noEmit` / tsserver / `mode "ide"`): position-preserving source-view tree.
//
// METHOD. Sweep the whole fixture corpus: pick a random file and identifier and append
// a distinctive suffix to one occurrence — a *syntactically valid* edit that injects a
// real semantic error (unresolved name / missing property) at a precise spot, without
// the parser-recovery noise a space-split would create (broken syntax recovers
// differently in the two structurally-different trees, which is not what the remap is
// about). Build the corpus twice through the actual transformer — `"emit"` (reprinted +
// remapped) and `"ide"` (position-preserving) — and diff the diagnostics. All randomness
// comes from one seed, printed into the failing assertion, so any failure replays with
// `MIXIN_STRESS_SEED=<seed>`. (`emit-source-view-diagnostic-parity.t.ts` pins one
// controlled case; this sweeps the corpus.)
//
// POSITION PARITY HOLDS. For a diagnostic both paths report (matched on
// `file:line:code:message`), they agree on line AND column: an audit over 1273
// single-identifier renames found 0 line drifts and 0 column mismatches. The emit path
// reprints the value-cast tree, so its raw diagnostics land on regenerated lines; each is
// remapped back through the printer's source map to the real source position
// (`printSourceFileWithMappings` + `wrapProgramDiagnostics` in `src/index.ts`; AGENTS.md
// "Emit-path diagnostic remapping"). So the ONLY difference between the paths is *which*
// diagnostics each reports — two real ones:
//
//   1. Downstream-consumer contract coverage (emit UNDER-reports). A `@mixin` not
//      satisfying its `implements` contract is flagged by both paths on the mixin
//      *declaration* (same TS2420; AGENTS.md "Emit-path implements conformance"). But a
//      *consumer* that uses the mixin where the contract is expected sees the generated
//      `interface X` that *inherited* the contract members, so it structurally "has" them
//      and emit reports nothing at the use-site, while source view flags it
//      (TS2741 / TS2551 / TS2339). Not a `tsc`-green hole: the body is checked at the
//      declaration (`class extends base implements Contract`), so a violation never
//      compiles either way — the editor merely flags the use sites in addition.
//
//   2. Heritage-clause navigation (IDE mis-positions; AGENTS.md invariant #9). For a base
//      name inside `extends` / `implements`, source view rewrites the clause to a generated
//      `$base` and reports the error at a synthetic position with a garbled message
//      (TS2304 / TS2552 / TS2724 as `Cannot find name '}'` etc.), while the compiler
//      reports it at the real base name — here the compiler is correct. Only affects
//      generic / construction-base consumers (and ones emitting validations), which keep
//      the `$base` rewrite; a non-generic, non-construction consumer takes the
//      navigable-base fast path and agrees with the compiler.
//
// WHAT THE ASSERTION DELIBERATELY IGNORES, to test position parity without tripping over
// those two differences: diagnostics inside a heritage clause (difference 2); perturbing
// base / mixin / interface names (cascades into heritage); `TS2578 Unused
// '@ts-expect-error'` (flips whenever coverage differs); and source-view-only diagnostics
// (difference 1 — tolerated, counted as `ideOnlyCoverageGaps`, not failed). What remains
// is strict: differing codes / counts at the *same* line are tolerated (benign semantic
// divergence, e.g. TS2720 vs TS2420, or construction `.new(...)` argument typing), but a
// line present in only one mode is a HARD failure — exactly the line drift this remap
// removes. Emit never reports on a line the source has no error on, and matches the
// source-view column wherever both report the same `file:line:code:message`.

const corpusDirectory = path.join(packageRoot, "tests", "fixture-suite", "src")

const compilerOptions: ts.CompilerOptions = {
    target                 : ts.ScriptTarget.ES2022,
    module                 : ts.ModuleKind.ESNext,
    moduleResolution       : ts.ModuleResolutionKind.Bundler,
    lib                    : [ "lib.es2022.d.ts", "lib.dom.d.ts" ],
    strict                 : true,
    useDefineForClassFields : false,
    skipLibCheck            : true,
    declaration             : true,
    experimentalDecorators  : false,
    noEmit                  : false
}

type Perturbation = {
    fileName : string
    text     : string
    line     : number
    column   : number
    word     : string
}

// Parsed source files that never change between iterations (lib + the unperturbed
// corpus) are cached so each build only reparses the single perturbed file.
const unchangedSourceFileCache = new Map<string, ts.SourceFile>()

// Original (on-disk) parse of a corpus file, cached, for heritage-range filtering of
// diagnostics reported in unperturbed files.
const originalSourceCache = new Map<string, ts.SourceFile>()

function originalSourceOfFile(fileName: string): ts.SourceFile | undefined {
    const cached = originalSourceCache.get(fileName)

    if (cached !== undefined) {
        return cached
    }

    let text: string

    try {
        text = readFileSync(fileName, "utf8")
    } catch {
        return undefined
    }

    const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

    originalSourceCache.set(fileName, sourceFile)

    return sourceFile
}

function createCachingHost(perturbation: Perturbation): ts.CompilerHost {
    const host         = ts.createCompilerHost(compilerOptions, true)
    const baseGetSource = host.getSourceFile.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (fileName === perturbation.fileName) {
            return ts.createSourceFile(fileName, perturbation.text, languageVersionOrOptions, true, ts.ScriptKind.TS)
        }

        const cached = unchangedSourceFileCache.get(fileName)

        if (cached !== undefined) {
            return cached
        }

        const sourceFile = baseGetSource(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)

        if (sourceFile !== undefined) {
            unchangedSourceFileCache.set(fileName, sourceFile)
        }

        return sourceFile
    }

    return host
}

function buildProgram(rootNames: string[], mode: "emit" | "ide", perturbation: Perturbation): ts.Program {
    const host         = createCachingHost(perturbation)
    const baseProgram  = ts.createProgram(rootNames, compilerOptions, host)

    return transformProgram(
        baseProgram,
        host,
        { allowUndefinedForRequiredProperties : true, mode },
        { ts } as never
    )
}

const heritageRangesCache = new WeakMap<ts.SourceFile, Array<{ start: number, end: number }>>()

// Spans of every `extends` / `implements` heritage clause in a file. Must be computed
// from the *original* source: source view rewrites the clause to a generated `$base`
// at a synthetic position, so its transformed tree's clause ranges do not line up with
// the original text. Both modes report diagnostics in *original* coordinates, so one
// original-text range set filters both symmetrically.
function heritageRanges(originalSourceFile: ts.SourceFile): Array<{ start: number, end: number }> {
    const cached = heritageRangesCache.get(originalSourceFile)

    if (cached !== undefined) {
        return cached
    }

    const ranges: Array<{ start: number, end: number }> = []

    const visit = (node: ts.Node): void => {
        if (ts.isHeritageClause(node)) {
            ranges.push({ start: node.getStart(originalSourceFile), end: node.getEnd() })
        }

        node.forEachChild(visit)
    }

    visit(originalSourceFile)
    heritageRangesCache.set(originalSourceFile, ranges)

    return ranges
}

type DiagnosticEntry = {
    line    : string  // `basename:line`
    column  : number
    code    : number
    message : string
}

// Every diagnostic the program reports as a `{ line, column, code }` entry, excluding
// diagnostics inside a heritage clause (the documented heritage-navigation gap: source
// view reports those at a synthetic position while emit reports them at the real base
// name — not a line-remap issue) and the coverage-coupled TS2578 (see below). Both modes
// report in original coordinates (emit after remapping, ide natively), so positions are
// directly comparable. The line is the granularity the remap fixes (reprinting shifts
// which line a diagnostic lands on); the column is asserted only where both trees report
// the same `file:line:code` (so the dual-tree presence differences do not interfere).
function diagnosticEntries(
    program: ts.Program,
    originalSourceFor: (fileName: string) => ts.SourceFile | undefined
): DiagnosticEntry[] {
    const entries: DiagnosticEntry[] = []

    for (const sourceFile of program.getSourceFiles()) {
        if (sourceFile.isDeclarationFile) {
            continue
        }

        const diagnostics = [
            ...program.getSyntacticDiagnostics(sourceFile),
            ...program.getSemanticDiagnostics(sourceFile),
            ...program.getDeclarationDiagnostics(sourceFile)
        ]

        for (const diagnostic of diagnostics) {
            if (diagnostic.file === undefined || diagnostic.start === undefined) {
                continue
            }

            // TS2578 (unused `@ts-expect-error`) flips whenever the two trees' coverage
            // differs: emit under-reporting a mixin-contract error elsewhere makes a
            // directive look unused. It is a coverage-coupled meta-diagnostic, not a
            // position signal.
            if (diagnostic.code === 2578) {
                continue
            }

            const original = originalSourceFor(diagnostic.file.fileName)
            const start     = diagnostic.start

            if (original !== undefined &&
                heritageRanges(original).some((range) => start >= range.start && start < range.end)
            ) {
                continue
            }

            const location = ts.getLineAndCharacterOfPosition(diagnostic.file, start)

            entries.push({
                line    : `${path.basename(diagnostic.file.fileName)}:${location.line + 1}`,
                column  : location.character + 1,
                code    : diagnostic.code,
                message : ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
            })
        }
    }

    return entries
}

// Identifier texts that appear inside any heritage clause anywhere in the corpus — the
// base / mixin / interface names. Renaming one cascades into the dual-tree heritage and
// required-base generated-reference gaps (source view places those references at a
// synthetic position, emit at the real name), which are documented divergences, not
// line drift. Skip them as perturbation targets.
function collectHeritageNames(rootNames: string[]): Set<string> {
    const names = new Set<string>()

    for (const fileName of rootNames) {
        const sourceFile = originalSourceOfFile(fileName)

        if (sourceFile === undefined) {
            continue
        }

        const visit = (node: ts.Node): void => {
            if (ts.isHeritageClause(node)) {
                const collectIdentifiers = (inner: ts.Node): void => {
                    if (ts.isIdentifier(inner)) {
                        names.add(inner.text)
                    }

                    inner.forEachChild(collectIdentifiers)
                }

                node.forEachChild(collectIdentifiers)

                return
            }

            node.forEachChild(visit)
        }

        visit(sourceFile)
    }

    return names
}

// End offsets of identifiers worth perturbing, chosen from the AST so we can skip the
// known-divergent sites: identifiers inside a heritage clause, and any identifier whose
// name participates in heritage anywhere (a base/mixin/interface name). Appending a
// suffix at the end keeps the file syntactically valid while renaming that one
// occurrence to a name that no longer resolves.
function collectPerturbableIdentifierOffsets(sourceFile: ts.SourceFile, heritageNames: Set<string>): number[] {
    const offsets: number[] = []

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) &&
            node.getEnd() - node.getStart(sourceFile) >= 2 &&
            !heritageNames.has(node.text) &&
            ts.findAncestor(node, (ancestor) => ts.isHeritageClause(ancestor)) === undefined
        ) {
            offsets.push(node.getEnd())
        }

        node.forEachChild(visit)
    }

    visit(sourceFile)

    return offsets
}

it("emit and source-view report diagnostics at the same source positions across the corpus", async (t: Test) => {
    const seed      = resolveSeed()
    const random    = new SeededRandom(seed)
    const rootNames = readdirSync(corpusDirectory)
        .filter((name) => name.endsWith(".ts"))
        .sort()
        .map((name) => path.join(corpusDirectory, name))

    t.isGreater(rootNames.length, 0, "fixture corpus is non-empty")

    const heritageNames = collectHeritageNames(rootNames)

    let perturbationsWithDiagnostics = 0
    let ideOnlyCoverageGaps          = 0
    let failure: string | undefined

    const iterations = runWithinBudget(() => {
        if (failure !== undefined) {
            return
        }

        const fileName = random.pick(rootNames)
        const text     = readFileSync(fileName, "utf8")
        const parsed   = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const offsets  = collectPerturbableIdentifierOffsets(parsed, heritageNames)

        if (offsets.length === 0) {
            return
        }

        const offset       = random.pick(offsets)
        const location     = ts.getLineAndCharacterOfPosition(parsed, offset)
        const perturbation: Perturbation = {
            fileName,
            text   : `${text.slice(0, offset)}Zq9${text.slice(offset)}`,
            line   : location.line + 1,
            column : location.character + 1,
            word   : text.slice(Math.max(0, offset - 6), offset)
        }

        // Heritage-clause spans come from the *original* text the compiled file holds:
        // the perturbed text for the edited file, on-disk text for the rest. Both modes'
        // diagnostics are in these coordinates, so the same ranges filter both.
        const perturbedSource  = ts.createSourceFile(fileName, perturbation.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const originalSourceFor = (diagnosticFileName: string): ts.SourceFile | undefined => {
            return diagnosticFileName === fileName ? perturbedSource : originalSourceOfFile(diagnosticFileName)
        }

        const emitEntries = diagnosticEntries(buildProgram(rootNames, "emit", perturbation), originalSourceFor)
        const ideEntries  = diagnosticEntries(buildProgram(rootNames, "ide", perturbation), originalSourceFor)

        const emitLines = new Set(emitEntries.map((entry) => entry.line))
        const ideLines  = new Set(ideEntries.map((entry) => entry.line))
        const onlyEmit  = [ ...emitLines ].filter((line) => !ideLines.has(line)).sort()
        const onlyIde   = [ ...ideLines ].filter((line) => !emitLines.has(line)).sort()

        if (emitLines.size > 0 || ideLines.size > 0) {
            perturbationsWithDiagnostics++
        }

        if (onlyIde.length > 0) {
            // Emit under-reports some mixin-contract errors the source-view tree catches
            // (a pre-existing dual-tree semantic-coverage gap, not a line-remap issue —
            // see TODO). We assert only the property the remap owns: emit never places an
            // error on a line the source has none on.
            ideOnlyCoverageGaps++
        }

        // Column parity: for a diagnostic both trees report, the remapped emit column
        // must match the source-view column. Match on `file:line:code:message` — the
        // message disambiguates two different errors that share a line+code (e.g.
        // `this.prefix` vs `this.label` both TS2339 on one line, where the trees' coverage
        // differs), so only genuinely-the-same diagnostic is compared.
        const columnKey  = (entry: DiagnosticEntry): string => `${entry.line}:${entry.code}:${entry.message}`
        const ideColumns = new Map<string, Set<number>>()

        for (const entry of ideEntries) {
            const columns = ideColumns.get(columnKey(entry)) ?? new Set<number>()

            columns.add(entry.column)
            ideColumns.set(columnKey(entry), columns)
        }

        const columnMismatch = emitEntries.find((entry) => {
            const columns = ideColumns.get(columnKey(entry))

            return columns !== undefined && !columns.has(entry.column)
        })

        if (onlyEmit.length > 0) {
            failure = [
                `Emit reported a diagnostic on a line the source-view path does not ` +
                    `(MIXIN_STRESS_SEED=${seed}) — a regenerated line that does not exist on disk.`,
                `Perturbed ${path.basename(fileName)} at ${perturbation.line}:${perturbation.column} ` +
                    `(renamed identifier ending ${JSON.stringify(perturbation.word)}).`,
                `Lines only in EMIT (the line-drift this fix removes): ${JSON.stringify(onlyEmit)}`,
                `Full emit lines: ${JSON.stringify([ ...emitLines ].sort())}`,
                `Full ide  lines: ${JSON.stringify([ ...ideLines ].sort())}`
            ].join("\n")
        } else if (columnMismatch !== undefined) {
            failure = [
                `Emit and source-view disagree on the COLUMN of TS${columnMismatch.code} at ` +
                    `${columnMismatch.line} (MIXIN_STRESS_SEED=${seed}).`,
                `Perturbed ${path.basename(fileName)} at ${perturbation.line}:${perturbation.column} ` +
                    `(renamed identifier ending ${JSON.stringify(perturbation.word)}).`,
                `Message: ${JSON.stringify(columnMismatch.message)}`,
                `Emit column: ${columnMismatch.column}; source-view columns for the same diagnostic: ` +
                    `${JSON.stringify([ ...(ideColumns.get(columnKey(columnMismatch)) ?? []) ])}`
            ].join("\n")
        }
    }, { durationMs : 8000, maxIterations : 24 })

    if (failure !== undefined) {
        t.fail(failure)
        return
    }

    t.isGreater(
        perturbationsWithDiagnostics,
        0,
        `expected at least one perturbation to produce diagnostics over ${iterations} iterations ` +
            `(seed ${seed}); otherwise the parity check ran vacuously`
    )

    t.pass(
        `emit never reported a diagnostic on a phantom line, and matched the source-view column ` +
            `wherever both report the same file:line:code, across ${iterations} corpus perturbations ` +
            `(${perturbationsWithDiagnostics} produced diagnostics; ${ideOnlyCoverageGaps} had source-view-only ` +
            `errors from the known coverage gap; seed ${seed})`
    )
})
