import type * as ts from "typescript"
import type { PrintedSourceMapping, TypeScript } from "./util.js"

export type DecodedSourceMapMapping = {
    generatedLine      : number,
    generatedCharacter : number,
    sourceIndex?       : number,
    sourceLine?        : number,
    sourceCharacter?   : number,
    nameIndex?         : number
}

type TypeScriptWithDecodeMappings = TypeScript & {
    decodeMappings(mappings: string): Iterable<DecodedSourceMapMapping>
}

// Decode a source map `mappings` string into absolute line/character segments, via the
// TypeScript-internal VLQ decoder (the encoder counterpart lives in `emit-source-map.ts`).
export function decodeSourceMapMappings(tsInstance: TypeScript, mappings: string): DecodedSourceMapMapping[] {
    return [ ...(tsInstance as TypeScriptWithDecodeMappings).decodeMappings(mappings) ]
}

// ---------------------------------------------------------------------------
// Emit-path source-map composition
//
// The emit plane compiles the REPRINTED text under the original file name, so the source
// map tsc produces is `generated (JS / .d.ts) -> printed`, while the file on disk is the
// ORIGINAL text — every position below the first generated insertion drifts, up to beyond
// the original EOF. The second leg (`printed -> original`) is already captured per reprinted
// file by `printSourceFileWithMappings` (it powers the emit-path diagnostic remap); this
// module composes the two legs at the `program.emit` seam: decode the emitted map, rewrite
// every segment's source position through the attached remap, re-encode, write.
//
// Segments originating in FULLY GENERATED regions — a printed line the printer produced no
// mapping for — are DROPPED: the debugger falls back to raw generated code there, the
// standard behaviour for generated output. A generated statement never maps onto a user line.

// Structurally matches the `DiagnosticRemap` each reprinted source file carries (index.ts);
// `sortedMappings` is a shared lazy cache, so both consumers sort at most once.
export type EmittedFileRemap = {
    originalSourceFile : ts.SourceFile,
    mappings           : PrintedSourceMapping[],
    sortedMappings?    : PrintedSourceMapping[]
}

export type EmittedFileRemapResolver = (file: ts.SourceFile | undefined) => EmittedFileRemap | undefined

type SourceMapJson = {
    version         : number,
    file?           : string,
    sourceRoot?     : string,
    sources         : string[],
    names?          : string[],
    mappings        : string,
    sourcesContent? : (string | null)[]
}

const inlineSourceMapMarker = "//# sourceMappingURL=data:application/json;base64,"

// The seam entry: given one emitted file, return its text with every embedded source map
// composed back to ORIGINAL positions. Non-map files without an inline map — and files
// whose sources carry no remap (untouched by the transform) — pass through unchanged, so
// their output stays byte-identical to a plugin-less build.
export function composeEmittedSourceMap(
    tsInstance: TypeScript,
    fileName: string,
    text: string,
    sourceFiles: readonly ts.SourceFile[] | undefined,
    remapOf: EmittedFileRemapResolver
): string {
    if (fileName.endsWith(".map")) {
        return rewriteSourceMapText(tsInstance, text, sourceFiles, remapOf) ?? text
    }

    const markerStart = text.lastIndexOf(inlineSourceMapMarker)

    if (markerStart === -1) {
        return text
    }

    const payloadStart = markerStart + inlineSourceMapMarker.length
    const payloadEnd   = endOfBase64Payload(text, payloadStart)
    const mapText      = decodeBase64(text.slice(payloadStart, payloadEnd))

    if (mapText === undefined) {
        return text
    }

    const rewritten = rewriteSourceMapText(tsInstance, mapText, sourceFiles, remapOf)

    if (rewritten === undefined) {
        return text
    }

    return text.slice(0, payloadStart) + encodeBase64(rewritten) + text.slice(payloadEnd)
}

// Rewrite one source map JSON text; `undefined` means "nothing to do" (unparseable, or no
// source in it was reprinted) and the caller keeps the original text byte-for-byte.
function rewriteSourceMapText(
    tsInstance: TypeScript,
    mapText: string,
    sourceFiles: readonly ts.SourceFile[] | undefined,
    remapOf: EmittedFileRemapResolver
): string | undefined {
    const map = parseSourceMapJson(mapText)

    if (map === undefined) {
        return undefined
    }

    const remaps = resolveSourceRemaps(map.sources, sourceFiles, remapOf)

    if (remaps.every((remap) => remap === undefined)) {
        return undefined
    }

    const composed: DecodedSourceMapMapping[] = []

    for (const segment of decodeSourceMapMappings(tsInstance, map.mappings)) {
        if (segment.sourceIndex === undefined ||
            segment.sourceLine === undefined ||
            segment.sourceCharacter === undefined
        ) {
            composed.push(segment)
            continue
        }

        const source = remaps[segment.sourceIndex]

        if (source === undefined) {
            composed.push(segment)
            continue
        }

        const translated = translatePrintedPosition(source, segment.sourceLine, segment.sourceCharacter)

        // A fully generated printed line, or a printed token that does not exist at the
        // translated original position (a generated statement anchored to its collapsed
        // gap range, e.g. `__X$mixin` onto the class's closing brace) — drop the segment:
        // never map generated code onto a user line; the debugger falls back to the raw
        // generated output there, the standard behaviour for generated code.
        if (translated === undefined) {
            continue
        }

        composed.push({
            ...segment,
            sourceLine      : translated.line,
            sourceCharacter : translated.character
        })
    }

    map.mappings = encodeSourceMapMappings(composed)

    // `inlineSources` embeds the text tsc read — the reprint. Replace it with the ORIGINAL.
    if (map.sourcesContent !== undefined) {
        map.sourcesContent = map.sourcesContent.map((content, index) => {
            return remaps[index]?.remap.originalSourceFile.text ?? content
        })
    }

    return JSON.stringify(map)
}

function parseSourceMapJson(mapText: string): SourceMapJson | undefined {
    try {
        const parsed = JSON.parse(mapText) as SourceMapJson

        if (typeof parsed !== "object" || parsed === null ||
            !Array.isArray(parsed.sources) || typeof parsed.mappings !== "string"
        ) {
            return undefined
        }

        return parsed
    } catch {
        return undefined
    }
}

// One map source resolved to its reprinted file: the remap plus both texts split into
// lines, for the token-agreement check the translation applies per segment.
type ResolvedSourceRemap = {
    remap         : EmittedFileRemap,
    printedLines  : string[],
    originalLines : string[]
}

// Pair each `sources` entry with the remap of the source file it was computed from. The
// emitter hands `sourceFiles` to `writeFile` in emit order; a plain (non-bundle) emit has
// exactly one entry, matching the map's single source. For the general case the entries
// are matched positionally when the counts agree, with a base-name check guarding against
// order surprises; an unmatched source keeps its segments untranslated.
function resolveSourceRemaps(
    sources: string[],
    sourceFiles: readonly ts.SourceFile[] | undefined,
    remapOf: EmittedFileRemapResolver
): (ResolvedSourceRemap | undefined)[] {
    const candidates = sourceFiles ?? []

    return sources.map((source, index) => {
        const positional = candidates.length === sources.length ? candidates[index] : undefined
        const matched    = positional !== undefined && sameBaseName(source, positional.fileName)
            ? positional
            : candidates.find((candidate) => sameBaseName(source, candidate.fileName))
        const remap      = remapOf(matched)

        if (matched === undefined || remap === undefined) {
            return undefined
        }

        return {
            remap,
            printedLines  : matched.text.split("\n"),
            originalLines : remap.originalSourceFile.text.split("\n")
        }
    })
}

function sameBaseName(left: string, right: string): boolean {
    return baseName(left) === baseName(right)
}

function baseName(fileName: string): string {
    return fileName.slice(fileName.lastIndexOf("/") + 1)
}

// ---------------------------------------------------------------------------
// The `printed -> original` translation

function sortedMappingsOf(remap: EmittedFileRemap): PrintedSourceMapping[] {
    if (remap.sortedMappings === undefined) {
        remap.sortedMappings = [ ...remap.mappings ].sort((left, right) => {
            return left.generatedLine - right.generatedLine ||
                left.generatedCharacter - right.generatedCharacter
        })
    }

    return remap.sortedMappings
}

// Index of the greatest entry whose printed position is `<=` the queried one; -1 when the
// query precedes every entry.
function precedingMappingIndex(
    sortedMappings: PrintedSourceMapping[],
    printedLine: number,
    printedCharacter: number
): number {
    let low   = 0
    let high  = sortedMappings.length - 1
    let match = -1

    while (low <= high) {
        const mid     = (low + high) >> 1
        const mapping = sortedMappings[mid]
        const ordered = mapping.generatedLine < printedLine ||
            mapping.generatedLine === printedLine && mapping.generatedCharacter <= printedCharacter

        if (ordered) {
            match = mid
            low   = mid + 1
        } else {
            high = mid - 1
        }
    }

    return match
}

// Translate a printed line/character to the original source, SAME-LINE only: an entry on
// the queried printed line anchors the translation and the generated-column delta advances
// from it (capped by the next entry on the same printed+source line, and by the original
// line's end). A printed line with no entries at all is fully generated — `undefined`, the
// caller drops the segment. This deliberately does NOT fall back to a preceding line the
// way the diagnostic remap does: a source map must never pin generated code to a user line.
//
// The remap also carries entries for GENERATED statements, collapsed onto gap ranges (they
// anchor emit diagnostics — the `'}'` family), and for generated references pinned onto
// user spans (e.g. `extends __X$base` onto the user's base name). Those must not leak into
// the source map, and the token-agreement check catches exactly them: when the printed
// position starts an identifier, the identifier at the translated original position must
// be the same word — user identifiers survive the reprint verbatim, generated names never
// match what sits at their collapsed anchor.
function translatePrintedPosition(
    source: ResolvedSourceRemap,
    printedLine: number,
    printedCharacter: number
): { line: number, character: number } | undefined {
    const sortedMappings = sortedMappingsOf(source.remap)
    const precedingIndex = precedingMappingIndex(sortedMappings, printedLine, printedCharacter)
    const preceding      = sortedMappings[precedingIndex]
    const sameLineAnchor = preceding !== undefined && preceding.generatedLine === printedLine
        ? { index: precedingIndex, mapping: preceding }
        : sameLineFollowingAnchor(sortedMappings, precedingIndex, printedLine)

    if (sameLineAnchor === undefined) {
        return undefined
    }

    const anchor    = sameLineAnchor.mapping
    const next      = sortedMappings[sameLineAnchor.index + 1]
    const capped    = next !== undefined &&
        next.generatedLine === printedLine &&
        next.sourceLine === anchor.sourceLine
        ? next.sourceCharacter
        : Number.POSITIVE_INFINITY
    const character = Math.min(
        Math.max(0, anchor.sourceCharacter + (printedCharacter - anchor.generatedCharacter)),
        capped
    )

    // A column past the original line's end cannot exist there: the anchor is a generated
    // statement collapsed onto a gap range (e.g. the mixin's closing `}`), and the queried
    // printed position lies inside the generated span — clamping would pin generated code
    // onto that user line (the leak the token-agreement check below cannot catch when the
    // position starts no identifier). Drop the segment instead.
    if (character > (source.originalLines[anchor.sourceLine] ?? "").length) {
        return undefined
    }

    const printedLineText = source.printedLines[printedLine] ?? ""
    const printedWord     = identifierAt(printedLineText, printedCharacter)

    if (printedWord !== undefined &&
        printedWord !== identifierAt(source.originalLines[anchor.sourceLine] ?? "", character)
    ) {
        return undefined
    }

    // A position that starts NO identifier still must agree: the raw printed character has
    // to be the character at the translated original position (quote style excepted — the
    // printer normalizes it). Generated punctuation anchored through a collapsed gap-range
    // entry lands within the user line's bounds otherwise — the `static new(`-onto-`}`
    // leak class the word check above cannot see. One exemption: an original position that
    // STARTS an identifier is a deliberate derived-from pin (the transform ranges generated
    // references onto the user token they come from — e.g. the branded base expression onto
    // the user's base name), and those must survive; a mapping onto a non-token position
    // (`}`, mid-word) never carries that meaning and is dropped.
    const originalLineText = source.originalLines[anchor.sourceLine] ?? ""

    if (printedWord === undefined &&
        identifierAt(originalLineText, character) === undefined &&
        !charactersAgree(printedLineText[printedCharacter], originalLineText[character])
    ) {
        return undefined
    }

    return { line: anchor.sourceLine, character }
}

const identifierCharPattern = /[A-Za-z0-9_$]/
const quoteCharacters       = new Set([ "\"", "'", "`" ])

// Non-identifier printed positions verify by raw character: whitespace and end-of-line
// count as one class (so CRLF tails and absent semicolons still agree), any quote matches
// any quote (the printer normalizes quote style), everything else must be the very same
// character.
function charactersAgree(printedChar: string | undefined, originalChar: string | undefined): boolean {
    const printed  = printedChar === undefined || printedChar.trim() === "" ? undefined : printedChar
    const original = originalChar === undefined || originalChar.trim() === "" ? undefined : originalChar

    if (printed === undefined || original === undefined) {
        return printed === original
    }

    return printed === original ||
        quoteCharacters.has(printed) && quoteCharacters.has(original)
}

// The identifier starting exactly at `character`, or `undefined` when the position does not
// begin one (punctuation, whitespace, or the middle of a word — a mid-word position cannot
// be the start-of-token the emitter maps, so it is left unverified).
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

// A queried position BEFORE the first entry of its printed line (e.g. an `export` modifier
// the printer mapped only past) still belongs to that user line: anchor on the line's first
// entry instead of dropping.
function sameLineFollowingAnchor(
    sortedMappings: PrintedSourceMapping[],
    precedingIndex: number,
    printedLine: number
): { index: number, mapping: PrintedSourceMapping } | undefined {
    const followingIndex = precedingIndex + 1
    const following      = sortedMappings[followingIndex]

    if (following === undefined || following.generatedLine !== printedLine) {
        return undefined
    }

    return { index: followingIndex, mapping: following }
}

// ---------------------------------------------------------------------------
// Source map `mappings` encoding (base64 VLQ) — the counterpart of the TypeScript-internal
// `decodeMappings`, which has no exposed encoder. Standard source-map-v3 delta encoding:
// the generated character resets per line; source index/line/character and name index run
// across the whole map.

const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function encodeVlq(value: number): string {
    let vlq     = value < 0 ? (-value << 1) + 1 : value << 1
    let encoded = ""

    do {
        let digit = vlq & 31

        vlq >>>= 5

        if (vlq > 0) {
            digit |= 32
        }

        encoded += base64Digits[digit]
    } while (vlq > 0)

    return encoded
}

export function encodeSourceMapMappings(segments: readonly DecodedSourceMapMapping[]): string {
    let encoded            = ""
    let line               = 0
    let previousCharacter  = 0
    let previousSource     = 0
    let previousSourceLine = 0
    let previousSourceChar = 0
    let previousName       = 0
    let firstOnLine        = true

    for (const segment of segments) {
        while (line < segment.generatedLine) {
            encoded          += ";"
            line             += 1
            previousCharacter = 0
            firstOnLine       = true
        }

        if (!firstOnLine) {
            encoded += ","
        }

        encoded          += encodeVlq(segment.generatedCharacter - previousCharacter)
        previousCharacter = segment.generatedCharacter
        firstOnLine       = false

        if (segment.sourceIndex !== undefined &&
            segment.sourceLine !== undefined &&
            segment.sourceCharacter !== undefined
        ) {
            encoded += encodeVlq(segment.sourceIndex - previousSource) +
                encodeVlq(segment.sourceLine - previousSourceLine) +
                encodeVlq(segment.sourceCharacter - previousSourceChar)

            previousSource     = segment.sourceIndex
            previousSourceLine = segment.sourceLine
            previousSourceChar = segment.sourceCharacter

            if (segment.nameIndex !== undefined) {
                encoded     += encodeVlq(segment.nameIndex - previousName)
                previousName = segment.nameIndex
            }
        }
    }

    return encoded
}

// ---------------------------------------------------------------------------
// Base64 helpers that work in both Node and other hosts (no Buffer dependency).

function endOfBase64Payload(text: string, start: number): number {
    let end = start

    while (end < text.length) {
        const char         = text.charCodeAt(end)
        const isBase64Char =
            char >= 65 && char <= 90 ||     // A-Z
            char >= 97 && char <= 122 ||    // a-z
            char >= 48 && char <= 57 ||     // 0-9
            char === 43 || char === 47 || char === 61  // + / =

        if (!isBase64Char) {
            break
        }

        end += 1
    }

    return end
}

declare function atob(data: string): string
declare function btoa(data: string): string

function decodeBase64(payload: string): string | undefined {
    try {
        const binary = atob(payload)
        const bytes  = new Uint8Array(binary.length)

        for (let index = 0; index < binary.length; index++) {
            bytes[index] = binary.charCodeAt(index)
        }

        return new TextDecoder().decode(bytes)
    } catch {
        return undefined
    }
}

function encodeBase64(text: string): string {
    const bytes = new TextEncoder().encode(text)
    let binary  = ""

    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }

    return btoa(binary)
}
