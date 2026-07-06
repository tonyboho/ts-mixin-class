import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { encodeSourceMapMappings } from "../src/emit-source-map.js"
import transformProgram from "../src/index.js"
import { resolveStressBudget, runWithinBudget } from "./stress/budget.js"
import { resolveSeed, SeededRandom } from "./stress/rng.js"
import { packageRoot } from "./util.js"

// The source-map twin of `stress-diagnostic-parity.t.ts`: compile the whole fixture
// corpus with `sourceMap` + `declarationMap` through the actual transformer, decode every
// emitted map, and assert mechanical invariants that need no per-token expectations
// (`emit-source-map.t.ts` pins the exact per-token behaviour on controlled fixtures):
//
//   1. BOUNDS — every segment's source position lies WITHIN the original file (the
//      beyond-EOF class of the pre-fix breakage: reprint coordinates written against the
//      on-disk file).
//   2. TOKEN AGREEMENT — for a mapped IDENTIFIER token in the generated output, the
//      original text at the mapped position starts with the same identifier. User
//      identifiers survive the reprint verbatim, so this is a strong mechanical check
//      that composed positions are real, not merely in-bounds. tsc's OWN conventions
//      legitimately break word identity for synthesized tokens — a synthesized
//      `constructor` maps to the class header, a hoisted `this.field = init` statement to
//      the field name, `get`/`set` to their `override` modifier — so the tolerated word
//      set is DERIVED from a plugin-less baseline compile of the same corpus rather than
//      hardcoded: a mismatch is a failure only for words the baseline never mismatches.
//   3. COMPLETENESS — every original line holding a `return` statement (always executable
//      user code) appears among a `.js.map`'s source lines: correct-but-sparse maps would
//      pass 1–2 while a debugger could not break on the lost lines.
//   4. UNTOUCHED IDENTITY — a file the transform leaves alone (its text in the transformed
//      program equals the on-disk text, i.e. it was never reprinted) emits output and maps
//      byte-identical to the plugin-less baseline.
//   5. ENCODER ROUND-TRIP — re-encoding the decoded segments of every BASELINE map (which
//      the composition never rewrites) reproduces the exact `mappings` string, validating
//      the hand-written VLQ encoder against TypeScript's decoder on real data.
//
// The sweep runs under BOTH `useDefineForClassFields` values — `true` emits fields in
// place instead of hoisting initializers into the constructor, a different mapping shape.
// A separate seeded-perturbation pass (replayable via `MIXIN_STRESS_SEED`) edits one
// identifier at a time and re-checks the per-file invariants on shapes the static corpus
// does not contain.

const corpusDirectory = path.join(packageRoot, "tests", "fixture-suite", "src")

function corpusRootNames(): string[] {
    return readdirSync(corpusDirectory)
        .filter((name) => name.endsWith(".ts"))
        .sort()
        .map((name) => path.join(corpusDirectory, name))
}

function compilerOptionsWith(useDefineForClassFields: boolean): ts.CompilerOptions {
    return {
        target                 : ts.ScriptTarget.ES2022,
        module                 : ts.ModuleKind.ESNext,
        moduleResolution       : ts.ModuleResolutionKind.Bundler,
        lib                    : [ "lib.es2022.d.ts", "lib.dom.d.ts" ],
        strict                 : true,
        useDefineForClassFields,
        skipLibCheck           : true,
        declaration            : true,
        declarationMap         : true,
        sourceMap              : true,
        experimentalDecorators : false,
        noEmit                 : false,
        outDir                 : "/sourcemap-stress-out"
    }
}

type DecodedSegment = {
    generatedLine      : number,
    generatedCharacter : number,
    sourceIndex?       : number,
    sourceLine?        : number,
    sourceCharacter?   : number
}

type TypeScriptWithSourceMapInternals = typeof ts & {
    decodeMappings(mappings: string): Iterable<DecodedSegment>
}

type EmittedOutput = {
    text        : string,
    sourceFiles : readonly ts.SourceFile[] | undefined
}

function decodeSegments(mappings: string): DecodedSegment[] {
    return [ ...(ts as TypeScriptWithSourceMapInternals).decodeMappings(mappings) ]
}

// Emit a program (or one file of it) to memory: output file name -> { text, sourceFiles }.
function emitToMemory(program: ts.Program, targetSourceFile?: ts.SourceFile): Map<string, EmittedOutput> {
    const outputs = new Map<string, EmittedOutput>()

    program.emit(targetSourceFile, (fileName, text, _writeByteOrderMark, _onError, sourceFiles) => {
        outputs.set(fileName, { text, sourceFiles })
    })

    return outputs
}

const diskTextCache = new Map<string, string | undefined>()

function diskTextOf(fileName: string): string | undefined {
    if (diskTextCache.has(fileName)) {
        return diskTextCache.get(fileName)
    }

    let text: string | undefined

    try {
        text = readFileSync(fileName, "utf8")
    } catch {
        text = undefined
    }

    diskTextCache.set(fileName, text)

    return text
}

const identifierCharPattern = /[A-Za-z0-9_$]/

// The identifier starting exactly at `character` of `lineText`, or undefined when the
// position does not begin one. Independent of the implementation's helper on purpose —
// the invariant re-derives the property from the emitted artifacts alone.
function identifierAt(lineText: string, character: number): string | undefined {
    if (character > 0 && identifierCharPattern.test(lineText[character - 1] ?? "")) {
        return undefined
    }

    let end = character

    while (end < lineText.length && identifierCharPattern.test(lineText[end])) {
        end += 1
    }

    return end > character ? lineText.slice(character, end) : undefined
}

type MapScan = {
    checkedMaps       : number,
    checkedSegments   : number,
    agreedTokens      : number,
    boundsOffenders   : string[],
    // Original `return` lines missing from a `.js.map`'s source lines.
    coverageOffenders : string[],
    // generated word -> sample offender descriptions
    mismatches        : Map<string, string[]>
}

// Decode every `.map` in `outputs`, checking each source-mapped segment for bounds and
// identifier-token agreement, plus `return`-line coverage per `.js.map`, against the
// original text `originalTextFor` resolves (disk for the plain sweeps, the in-memory
// perturbed text for the perturbation pass).
function scanMaps(
    outputs: Map<string, EmittedOutput>,
    originalTextFor: (fileName: string) => string | undefined
): MapScan {
    const scan: MapScan = {
        checkedMaps       : 0,
        checkedSegments   : 0,
        agreedTokens      : 0,
        boundsOffenders   : [],
        coverageOffenders : [],
        mismatches        : new Map()
    }

    for (const [ fileName, output ] of outputs) {
        if (!fileName.endsWith(".map")) {
            continue
        }

        scan.checkedMaps += 1

        const map = JSON.parse(output.text) as { sources: string[], mappings: string }

        // Per-file emit: one source per map, handed to `writeFile` alongside the text.
        const sourceFile     = output.sourceFiles?.[0]
        const originalLines  = sourceFile === undefined ? undefined : originalTextFor(sourceFile.fileName)?.split("\n")
        const generatedLines = outputs.get(fileName.slice(0, -".map".length))?.text.split("\n")

        if (originalLines === undefined || generatedLines === undefined) {
            scan.boundsOffenders.push(`${path.basename(fileName)}: could not resolve its source or generated text`)
            continue
        }

        const generatedLinesOf = new Map<number, number[]>()

        for (const segment of decodeSegments(map.mappings)) {
            if (segment.sourceLine === undefined || segment.sourceCharacter === undefined) {
                continue
            }

            scan.checkedSegments += 1

            const segmentTargets = generatedLinesOf.get(segment.sourceLine) ?? []

            segmentTargets.push(segment.generatedLine)
            generatedLinesOf.set(segment.sourceLine, segmentTargets)

            const where = `${path.basename(fileName)}: generated ` +
                `${segment.generatedLine + 1}:${segment.generatedCharacter} -> ` +
                `source ${segment.sourceLine + 1}:${segment.sourceCharacter}`

            if (segment.sourceLine >= originalLines.length ||
                segment.sourceCharacter > originalLines[segment.sourceLine].length
            ) {
                scan.boundsOffenders.push(`${where} (file has ${originalLines.length} lines)`)
                continue
            }

            const generatedWord = identifierAt(generatedLines[segment.generatedLine] ?? "", segment.generatedCharacter)

            if (generatedWord === undefined) {
                continue
            }

            const originalLine = originalLines[segment.sourceLine]

            if (originalLine.startsWith(generatedWord, segment.sourceCharacter)) {
                scan.agreedTokens += 1
            } else {
                const samples = scan.mismatches.get(generatedWord) ?? []

                samples.push(
                    `${where}: generated token ${JSON.stringify(generatedWord)} vs original ` +
                    JSON.stringify(originalLine.slice(segment.sourceCharacter, segment.sourceCharacter + generatedWord.length + 8))
                )
                scan.mismatches.set(generatedWord, samples)
            }
        }

        // Completeness — only the runnable-code map carries executable lines. Reachability
        // alone is not enough: at least one generated line mapping to the `return` line must
        // itself contain `return`, so a debugger's reverse lookup (how breakpoints bind)
        // lands on the actual statement.
        if (fileName.endsWith(".js.map")) {
            for (const [ index, line ] of originalLines.entries()) {
                const trimmed = line.trim()

                if (!trimmed.startsWith("return ") && trimmed !== "return") {
                    continue
                }

                const targets = generatedLinesOf.get(index)

                if (targets === undefined) {
                    scan.coverageOffenders.push(`${path.basename(fileName)}: original return line ${index + 1} unreachable`)
                } else if (!targets.some((generatedLine) => (generatedLines[generatedLine] ?? "").includes("return"))) {
                    scan.coverageOffenders.push(
                        `${path.basename(fileName)}: original return line ${index + 1} maps only to ` +
                        `generated lines without \`return\` (${targets.join(", ")})`
                    )
                }
            }
        }
    }

    return scan
}

// One convention a plugin-less baseline cannot exhibit: declaration emit for a class
// extending an EXPRESSION (the transformed runtime mixin chain / construction brand)
// synthesizes `declare const <Class>_base: ...` and maps the statement or reference onto
// the class header / heritage — tsc's own shape, not composition drift.
function expressionBaseConvention(word: string): boolean {
    return word === "declare" || word.endsWith("_base")
}

function filteredAgreementOffenders(scan: MapScan, toleratedWords: Set<string>): string[] {
    return [ ...scan.mismatches ]
        .filter(([ word ]) => !toleratedWords.has(word) && !expressionBaseConvention(word))
        .flatMap(([ , samples ]) => samples)
}

// The baseline (plugin-less) compile of the corpus for one option set: its outputs, its
// scan, and the tolerated-word set the transformed sweep and the perturbation pass reuse.
type BaselineArtifacts = {
    outputs        : Map<string, EmittedOutput>,
    scan           : MapScan,
    toleratedWords : Set<string>
}

const baselineCache = new Map<string, BaselineArtifacts>()

function baselineArtifacts(useDefineForClassFields: boolean): BaselineArtifacts {
    const cacheKey = String(useDefineForClassFields)
    const cached   = baselineCache.get(cacheKey)

    if (cached !== undefined) {
        return cached
    }

    const compilerOptions = compilerOptionsWith(useDefineForClassFields)
    const host            = ts.createCompilerHost(compilerOptions, true)
    const outputs         = emitToMemory(ts.createProgram(corpusRootNames(), compilerOptions, host))
    const scan            = scanMaps(outputs, diskTextOf)
    const artifacts       = { outputs, scan, toleratedWords: new Set(scan.mismatches.keys()) }

    baselineCache.set(cacheKey, artifacts)

    return artifacts
}

function buildTransformedProgram(
    compilerOptions: ts.CompilerOptions,
    host: ts.CompilerHost
): ts.Program {
    return transformProgram(
        ts.createProgram(corpusRootNames(), compilerOptions, host),
        host,
        { fillMissedInitializersWith: "undefined", mode: "emit" },
        { ts } as never
    )
}

function sweep(t: Test, useDefineForClassFields: boolean): void {
    const label           = `uDFCF=${useDefineForClassFields}`
    const rootNames       = corpusRootNames()
    const compilerOptions = compilerOptionsWith(useDefineForClassFields)

    t.isGreater(rootNames.length, 0, `[${label}] fixture corpus is non-empty`)

    const transformedHost    = ts.createCompilerHost(compilerOptions, true)
    const transformedProgram = buildTransformedProgram(compilerOptions, transformedHost)
    const transformed        = emitToMemory(transformedProgram)
    const baseline           = baselineArtifacts(useDefineForClassFields)

    t.isGreater(transformed.size, 0, `[${label}] the transformed compile emitted output files`)

    // Encoder round-trip on the baseline maps (never rewritten by the composition):
    // re-encoding the decoded segments must reproduce the exact mappings string.
    const roundTripOffenders: string[] = []

    for (const [ fileName, output ] of baseline.outputs) {
        if (!fileName.endsWith(".map")) {
            continue
        }

        const mappings = (JSON.parse(output.text) as { mappings: string }).mappings

        if (encodeSourceMapMappings(decodeSegments(mappings)) !== mappings) {
            roundTripOffenders.push(path.basename(fileName))
        }
    }

    t.equal(
        roundTripOffenders.length,
        0,
        `[${label}] the VLQ encoder round-trips every baseline map byte-identically` +
            (roundTripOffenders.length > 0 ? `; offenders: ${roundTripOffenders.slice(0, 10).join(", ")}` : "")
    )

    const transformedScan    = scanMaps(transformed, diskTextOf)
    const agreementOffenders = filteredAgreementOffenders(transformedScan, baseline.toleratedWords)

    t.isGreater(transformedScan.checkedMaps, 0, `[${label}] the sweep decoded emitted maps`)
    t.isGreater(transformedScan.checkedSegments, 0, `[${label}] the sweep saw source-mapped segments`)
    t.isGreater(transformedScan.agreedTokens, 0, `[${label}] the sweep verified identifier tokens`)

    t.equal(
        transformedScan.boundsOffenders.length,
        0,
        `[${label}] no segment maps beyond its original file (${transformedScan.checkedSegments} segments checked)` +
            (transformedScan.boundsOffenders.length > 0
                ? `; offenders:\n${transformedScan.boundsOffenders.slice(0, 10).join("\n")}`
                : "")
    )
    t.equal(
        agreementOffenders.length,
        0,
        `[${label}] every mapped identifier token exists verbatim at its original position ` +
            `(${transformedScan.agreedTokens} agreed; tolerated words from baseline: ` +
            `${[ ...baseline.toleratedWords ].sort().join(", ") || "<none>"})` +
            (agreementOffenders.length > 0 ? `; offenders:\n${agreementOffenders.slice(0, 10).join("\n")}` : "")
    )
    t.equal(
        transformedScan.coverageOffenders.length,
        0,
        `[${label}] every original return line stays reachable through its .js.map` +
            (transformedScan.coverageOffenders.length > 0
                ? `; offenders:\n${transformedScan.coverageOffenders.slice(0, 10).join("\n")}`
                : "")
    )

    // Untouched identity. "Untouched" is exact: the transformed program serves the file
    // with its on-disk text (a reprinted file's text differs). Every emitted artifact of
    // an untouched file must be byte-identical to the plugin-less baseline.
    const identityOffenders: string[] = []
    let untouchedFiles                = 0
    let reprintedFiles                = 0

    for (const fileName of rootNames) {
        const programSourceFile = transformedProgram.getSourceFile(fileName)

        if (programSourceFile === undefined || programSourceFile.text !== diskTextOf(fileName)) {
            reprintedFiles += 1
            continue
        }

        untouchedFiles += 1

        const outputBase = `/sourcemap-stress-out/${path.basename(fileName, ".ts")}`

        for (const suffix of [ ".js", ".js.map", ".d.ts", ".d.ts.map" ]) {
            const transformedOutput = transformed.get(outputBase + suffix)
            const baselineOutput    = baseline.outputs.get(outputBase + suffix)

            if (transformedOutput?.text !== baselineOutput?.text) {
                identityOffenders.push(path.basename(outputBase + suffix))
            }
        }
    }

    t.isGreater(reprintedFiles, 0, `[${label}] the corpus exercises reprinted files`)

    t.equal(
        identityOffenders.length,
        0,
        `[${label}] every artifact of an untouched file (${untouchedFiles} files) is byte-identical to the plugin-less baseline` +
            (identityOffenders.length > 0 ? `; offenders: ${identityOffenders.join(", ")}` : "")
    )
}

it("every map emitted over the corpus honours the invariants (useDefineForClassFields: false)", (t: Test) => {
    sweep(t, false)
})

it("every map emitted over the corpus honours the invariants (useDefineForClassFields: true)", (t: Test) => {
    sweep(t, true)
})

// ---------------------------------------------------------------------------
// Seeded perturbations: edit one identifier at a time (a syntactically valid rename that
// may or may not keep the file a mixin/consumer at all), rebuild through the transformer,
// emit JUST that file and re-check the per-file invariants against the PERTURBED text.
// Replay a failure with `MIXIN_STRESS_SEED=<seed>`.

// Parsed source files that never change between iterations (lib + the unperturbed corpus)
// are cached so each build only reparses the single perturbed file.
const unchangedSourceFileCache = new Map<string, ts.SourceFile>()

function createCachingHost(
    compilerOptions: ts.CompilerOptions,
    perturbedFileName: string,
    perturbedText: string
): ts.CompilerHost {
    const host          = ts.createCompilerHost(compilerOptions, true)
    const baseGetSource = host.getSourceFile.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (fileName === perturbedFileName) {
            return ts.createSourceFile(fileName, perturbedText, languageVersionOrOptions, true, ts.ScriptKind.TS)
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

// End offsets of identifiers worth perturbing: appending a suffix at an identifier's end
// keeps the file syntactically valid while renaming that one occurrence.
function collectIdentifierOffsets(sourceFile: ts.SourceFile): number[] {
    const offsets: number[] = []

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.getEnd() - node.getStart(sourceFile) >= 2) {
            offsets.push(node.getEnd())
        }

        node.forEachChild(visit)
    }

    visit(sourceFile)

    return offsets
}

it("seeded corpus perturbations keep the per-file invariants", (t: Test) => {
    const seed            = resolveSeed()
    const random          = new SeededRandom(seed)
    const rootNames       = corpusRootNames()
    const compilerOptions = compilerOptionsWith(false)
    const baseline        = baselineArtifacts(false)

    let checkedIterations = 0
    let failure: string | undefined

    const iterations = runWithinBudget(() => {
        if (failure !== undefined) {
            return
        }

        const fileName = random.pick(rootNames)
        const text     = diskTextOf(fileName)

        if (text === undefined) {
            return
        }

        const parsed  = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
        const offsets = collectIdentifierOffsets(parsed)

        if (offsets.length === 0) {
            return
        }

        const offset        = random.pick(offsets)
        const perturbedText = `${text.slice(0, offset)}Zq9${text.slice(offset)}`
        const host          = createCachingHost(compilerOptions, fileName, perturbedText)
        const program       = buildTransformedProgram(compilerOptions, host)
        const target        = program.getSourceFile(fileName)

        if (target === undefined) {
            failure = `seed=${seed}: ${path.basename(fileName)} disappeared from the program after perturbation at offset ${offset}`
            return
        }

        const outputs = emitToMemory(program, target)
        const scan    = scanMaps(outputs, (scannedFileName) => {
            return scannedFileName === fileName ? perturbedText : diskTextOf(scannedFileName)
        })

        const boundsOffenders    = scan.boundsOffenders
        const agreementOffenders = filteredAgreementOffenders(scan, baseline.toleratedWords)
        const problems           = [
            ...boundsOffenders.map((offender) => `bounds: ${offender}`),
            ...agreementOffenders.map((offender) => `agreement: ${offender}`),
            ...scan.coverageOffenders.map((offender) => `coverage: ${offender}`)
        ]

        if (problems.length > 0) {
            failure = `seed=${seed}: perturbing ${path.basename(fileName)} at offset ${offset} broke the invariants:\n` +
                problems.slice(0, 10).join("\n")
        }

        checkedIterations += 1
    }, resolveStressBudget())

    t.true(failure === undefined, failure ?? `seed=${seed}: ${checkedIterations}/${iterations} perturbations kept all invariants`)
    t.isGreater(checkedIterations, 0, `seed=${seed}: the perturbation pass exercised at least one edit`)
})
