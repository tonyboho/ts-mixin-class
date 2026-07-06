import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import transformProgram from "../src/index.js"
import { packageRoot } from "./util.js"

// The source-map twin of `stress-diagnostic-parity.t.ts`: compile the whole fixture
// corpus with `sourceMap` + `declarationMap` through the actual transformer, decode every
// emitted map, and assert mechanical invariants that need no per-token expectations
// (`emit-source-map.t.ts` pins the exact per-token behaviour on one controlled fixture):
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
//   3. UNTOUCHED IDENTITY — a file the transform leaves alone (its text in the transformed
//      program equals the on-disk text, i.e. it was never reprinted) emits output and maps
//      byte-identical to the plugin-less baseline.

const corpusDirectory = path.join(packageRoot, "tests", "fixture-suite", "src")

const compilerOptions: ts.CompilerOptions = {
    target                  : ts.ScriptTarget.ES2022,
    module                  : ts.ModuleKind.ESNext,
    moduleResolution        : ts.ModuleResolutionKind.Bundler,
    lib                     : [ "lib.es2022.d.ts", "lib.dom.d.ts" ],
    strict                  : true,
    useDefineForClassFields : false,
    skipLibCheck            : true,
    declaration             : true,
    declarationMap          : true,
    sourceMap               : true,
    experimentalDecorators  : false,
    noEmit                  : false,
    outDir                  : "/sourcemap-stress-out"
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

// Emit the whole program to memory: output file name -> { text, sourceFiles }.
function emitToMemory(program: ts.Program): Map<string, EmittedOutput> {
    const outputs = new Map<string, EmittedOutput>()

    program.emit(undefined, (fileName, text, _writeByteOrderMark, _onError, sourceFiles) => {
        outputs.set(fileName, { text, sourceFiles })
    })

    return outputs
}

const originalTextCache = new Map<string, string | undefined>()

function originalTextOf(fileName: string): string | undefined {
    if (originalTextCache.has(fileName)) {
        return originalTextCache.get(fileName)
    }

    let text: string | undefined

    try {
        text = readFileSync(fileName, "utf8")
    } catch {
        text = undefined
    }

    originalTextCache.set(fileName, text)

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
    checkedMaps     : number,
    checkedSegments : number,
    agreedTokens    : number,
    boundsOffenders : string[],
    // generated word -> sample offender description
    mismatches      : Map<string, string[]>
}

// Decode every `.map` in `outputs`, checking each source-mapped segment for bounds and
// identifier-token agreement against the ON-DISK original text.
function scanMaps(outputs: Map<string, EmittedOutput>): MapScan {
    const scan: MapScan = {
        checkedMaps     : 0,
        checkedSegments : 0,
        agreedTokens    : 0,
        boundsOffenders : [],
        mismatches      : new Map()
    }

    for (const [ fileName, output ] of outputs) {
        if (!fileName.endsWith(".map")) {
            continue
        }

        scan.checkedMaps += 1

        const map = JSON.parse(output.text) as { sources: string[], mappings: string }

        // Per-file emit: one source per map, handed to `writeFile` alongside the text.
        const sourceFile     = output.sourceFiles?.[0]
        const originalLines  = sourceFile === undefined ? undefined : originalTextOf(sourceFile.fileName)?.split("\n")
        const generatedLines = outputs.get(fileName.slice(0, -".map".length))?.text.split("\n")

        if (originalLines === undefined || generatedLines === undefined) {
            scan.boundsOffenders.push(`${path.basename(fileName)}: could not resolve its source or generated text`)
            continue
        }

        for (const segment of decodeSegments(map.mappings)) {
            if (segment.sourceLine === undefined || segment.sourceCharacter === undefined) {
                continue
            }

            scan.checkedSegments += 1

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
    }

    return scan
}

it("every map emitted over the corpus honours bounds, token agreement, and untouched identity", (t: Test) => {
    const rootNames = readdirSync(corpusDirectory)
        .filter((name) => name.endsWith(".ts"))
        .sort()
        .map((name) => path.join(corpusDirectory, name))

    t.isGreater(rootNames.length, 0, "fixture corpus is non-empty")

    const transformedHost    = ts.createCompilerHost(compilerOptions, true)
    const transformedProgram = transformProgram(
        ts.createProgram(rootNames, compilerOptions, transformedHost),
        transformedHost,
        { fillMissedInitializersWith: "undefined", mode: "emit" },
        { ts } as never
    )
    const transformed        = emitToMemory(transformedProgram)

    const baselineHost = ts.createCompilerHost(compilerOptions, true)
    const baseline     = emitToMemory(ts.createProgram(rootNames, compilerOptions, baselineHost))

    t.isGreater(transformed.size, 0, "the transformed compile emitted output files")

    // Bounds + token agreement, with the tolerated-word set derived from the baseline:
    // whatever words tsc's own maps mismatch (synthesized constructors, hoisted field
    // initializers, modifier-stripped accessors) are its conventions, not our drift.
    const baselineScan    = scanMaps(baseline)
    const transformedScan = scanMaps(transformed)
    const toleratedWords  = new Set(baselineScan.mismatches.keys())

    // One convention the baseline cannot exhibit: declaration emit for a class extending
    // an EXPRESSION (the transformed runtime mixin chain) synthesizes
    // `declare const <Class>_base: ...` and maps both the statement and the reference onto
    // the class header / heritage — tsc's own shape, not composition drift.
    const expressionBaseConvention = (word: string): boolean => word === "declare" || word.endsWith("_base")

    const agreementOffenders = [ ...transformedScan.mismatches ]
        .filter(([ word ]) => !toleratedWords.has(word) && !expressionBaseConvention(word))
        .flatMap(([ , samples ]) => samples)

    t.isGreater(transformedScan.checkedMaps, 0, "the sweep decoded emitted maps")
    t.isGreater(transformedScan.checkedSegments, 0, "the sweep saw source-mapped segments")
    t.isGreater(transformedScan.agreedTokens, 0, "the sweep verified identifier tokens")

    t.equal(
        transformedScan.boundsOffenders.length,
        0,
        `no segment maps beyond its original file (${transformedScan.checkedSegments} segments checked)` +
            (transformedScan.boundsOffenders.length > 0
                ? `; offenders:\n${transformedScan.boundsOffenders.slice(0, 10).join("\n")}`
                : "")
    )
    t.equal(
        agreementOffenders.length,
        0,
        `every mapped identifier token exists verbatim at its original position ` +
            `(${transformedScan.agreedTokens} agreed; tolerated words from baseline: ` +
            `${[ ...toleratedWords ].sort().join(", ") || "<none>"})` +
            (agreementOffenders.length > 0 ? `; offenders:\n${agreementOffenders.slice(0, 10).join("\n")}` : "")
    )

    // Untouched identity. "Untouched" is exact: the transformed program serves the file
    // with its on-disk text (a reprinted file's text differs). Every emitted artifact of
    // an untouched file must be byte-identical to the plugin-less baseline.
    const identityOffenders: string[] = []
    let untouchedFiles                = 0
    let reprintedFiles                = 0

    for (const fileName of rootNames) {
        const programSourceFile = transformedProgram.getSourceFile(fileName)

        if (programSourceFile === undefined || programSourceFile.text !== originalTextOf(fileName)) {
            reprintedFiles += 1
            continue
        }

        untouchedFiles += 1

        const outputBase = `/sourcemap-stress-out/${path.basename(fileName, ".ts")}`

        for (const suffix of [ ".js", ".js.map", ".d.ts", ".d.ts.map" ]) {
            const transformedOutput = transformed.get(outputBase + suffix)
            const baselineOutput    = baseline.get(outputBase + suffix)

            if (transformedOutput?.text !== baselineOutput?.text) {
                identityOffenders.push(path.basename(outputBase + suffix))
            }
        }
    }

    t.isGreater(reprintedFiles, 0, "the corpus exercises reprinted files")

    t.equal(
        identityOffenders.length,
        0,
        `every artifact of an untouched file (${untouchedFiles} files) is byte-identical to the plugin-less baseline` +
            (identityOffenders.length > 0 ? `; offenders: ${identityOffenders.join(", ")}` : "")
    )
})
