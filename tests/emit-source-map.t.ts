import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { startTscWatch } from "./tsc-watch-util.js"
import { commandOutput, createTypeScriptFixture, packageRoot, runCommand, trimIndent } from "./util.js"
import type { TypeScriptFixture } from "./util.js"

// The emit plane compiles the REPRINTED text under the original file name, so the `.js.map`
// tsc produces is `JS -> printed`; without composing the second leg (`printed -> original`,
// captured by `printSourceFileWithMappings`) every user position below the first generated
// insertion drifts — breakpoints land on wrong lines or beyond the original EOF. This suite
// pins the composed behaviour:
//
//   1. user code maps EXACTLY (line AND column) — including the max-drift zone after the
//      last generated insertion and a field initializer hoisted into a generated constructor;
//   2. generated artifacts (`__X$mixin` factory, `__defineMixinClass__` call, `$base`,
//      `__mixinChainLinearized__`) never map onto user lines;
//   3. every mapped source position lies WITHIN the original file bounds;
//   4. a file the transform leaves untouched emits `.js` / `.js.map` byte-identical to a
//      plugin-less build;
//   5. the same holds for `inlineSourceMap` (map rides inside the `.js` as a data URI),
//      `inlineSources` (`sourcesContent` embeds the ORIGINAL text, not the reprint), and
//      `declarationMap` (`.d.ts.map`).

const sourceText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Greeter {
        public name: string = "Ada"

        greet(): string {
            return \`hello \${this.name}\`
        }
    }

    class Consumer extends Base implements Greeter {
        public tag: string = ""

        describe(): string {
            return \`\${this.greet()} [\${this.tag}]\`
        }
    }

    const one = Consumer.new({ name: "Grace", tag: "x" })

    export const afterAll: string = one.describe()
`)

const plainText = trimIndent(`
    export function double(value: number): number {
        return value * 2
    }
`)

// ---------------------------------------------------------------------------
// Decoded-map helpers

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

function decodeSegments(mappings: string): DecodedSegment[] {
    return [ ...(ts as TypeScriptWithSourceMapInternals).decodeMappings(mappings) ]
}

type SourceMapJson = {
    sources         : string[],
    sourcesContent? : string[],
    mappings        : string
}

// 0-based line/character of `needle` (must be unique in `text`) plus `offset` characters.
function positionOf(text: string, needle: string, offset = 0): { line: number, character: number } {
    const index = text.indexOf(needle)

    if (index < 0) {
        throw new Error(`needle not found: ${JSON.stringify(needle)}`)
    }

    if (text.indexOf(needle, index + 1) >= 0) {
        throw new Error(`needle is not unique: ${JSON.stringify(needle)}`)
    }

    const target = index + offset
    const before = text.slice(0, target)
    const line   = before.split("\n").length - 1

    return { line, character: target - (before.lastIndexOf("\n") + 1) }
}

function formatPosition(position: { line: number, character: number }): string {
    return `${position.line}:${position.character}`
}

// The segment sitting exactly on the generated (JS / d.ts) position of a token.
function segmentAt(
    segments: DecodedSegment[],
    generated: { line: number, character: number }
): DecodedSegment | undefined {
    return segments.find((segment) => {
        return segment.generatedLine === generated.line && segment.generatedCharacter === generated.character
    })
}

// Spec 1: the emitted token at `generatedNeedle`(+offset) maps EXACTLY (line and column)
// to the original token at `originalNeedle`(+offset).
function assertExactMapping(
    t: Test,
    description: string,
    segments: DecodedSegment[],
    generatedText: string,
    generatedNeedle: string,
    originalText: string,
    originalNeedle: string,
    needleOffset = 0,
    originalNeedleOffset = needleOffset
): void {
    const generated = positionOf(generatedText, generatedNeedle, needleOffset)
    const expected  = positionOf(originalText, originalNeedle, originalNeedleOffset)
    const segment   = segmentAt(segments, generated)

    if (segment === undefined || segment.sourceLine === undefined || segment.sourceCharacter === undefined) {
        t.fail(`${description}: no source-mapped segment at generated ${formatPosition(generated)}`)
        return
    }

    t.equal(
        formatPosition({ line: segment.sourceLine, character: segment.sourceCharacter }),
        formatPosition(expected),
        `${description}: generated ${formatPosition(generated)} maps to the original token exactly`
    )
}

// Spec 2 (deterministic face): the emitted token at `generatedNeedle`(+offset) carries NO
// source mapping at all — it lives in a fully generated region.
function assertUnmapped(
    t: Test,
    description: string,
    segments: DecodedSegment[],
    generatedText: string,
    generatedNeedle: string,
    needleOffset = 0
): void {
    const generated = positionOf(generatedText, generatedNeedle, needleOffset)
    const segment   = segmentAt(segments, generated)

    t.true(
        segment === undefined || segment.sourceLine === undefined,
        `${description}: generated ${formatPosition(generated)} carries no source mapping` +
            (segment?.sourceLine !== undefined ? ` (maps to ${segment.sourceLine}:${segment.sourceCharacter})` : "")
    )
}

// Spec 3: every mapped source position lies within the original file bounds — the
// beyond-EOF drift class. Column is bounded by the mapped line's length.
function assertSegmentsWithinOriginal(
    t: Test,
    description: string,
    segments: DecodedSegment[],
    originalText: string
): void {
    const lines  = originalText.split("\n")
    const broken = segments.filter((segment) => {
        if (segment.sourceLine === undefined || segment.sourceCharacter === undefined) {
            return false
        }

        return segment.sourceLine >= lines.length ||
            segment.sourceCharacter > lines[segment.sourceLine].length
    })

    t.equal(
        broken.length,
        0,
        `${description}: no segment maps beyond the original file bounds` +
            (broken.length > 0
                ? `; first offender: src ${broken[0].sourceLine}:${broken[0].sourceCharacter} of ${lines.length} lines`
                : "")
    )
}

// Spec 2: a segment sitting ON a generated artifact token never carries a source mapping.
function assertArtifactTokensUnmapped(
    t: Test,
    description: string,
    segments: DecodedSegment[],
    generatedText: string
): void {
    const artifactPattern     = /__defineMixinClass__|__\w+\$mixin|__\w+\$base|__mixinChainLinearized__/g
    const offenders: string[] = []

    for (const [ lineIndex, lineText ] of generatedText.split("\n").entries()) {
        for (const match of lineText.matchAll(artifactPattern)) {
            const segment = segmentAt(segments, { line: lineIndex, character: match.index })

            if (segment !== undefined && segment.sourceLine !== undefined) {
                offenders.push(
                    `${match[0]} at ${lineIndex}:${match.index} -> src ${segment.sourceLine}:${segment.sourceCharacter}`
                )
            }
        }
    }

    t.equal(offenders.length, 0, `${description}: generated artifact tokens carry no source mapping` +
        (offenders.length > 0 ? `; offenders:\n${offenders.join("\n")}` : ""))
}

// COMPLETENESS: a map whose segments are all correct but sparse would still pass the
// checks above — a debugger could not break on the lines it lost. Every original line
// holding a `return` statement (always executable user code) must appear among the map's
// source lines — AND at least one of the generated lines mapping to it must itself contain
// `return`, so a debugger's reverse lookup (original -> generated, how breakpoints bind)
// lands on the actual statement rather than an unrelated mapped fragment.
function assertReturnLinesCovered(
    t: Test,
    description: string,
    segments: DecodedSegment[],
    originalText: string,
    generatedText: string
): void {
    const generatedLines    = generatedText.split("\n")
    const generatedLinesOf  = new Map<number, number[]>()
    const missing: string[] = []

    for (const segment of segments) {
        if (segment.sourceLine === undefined) {
            continue
        }

        const lines = generatedLinesOf.get(segment.sourceLine) ?? []

        lines.push(segment.generatedLine)
        generatedLinesOf.set(segment.sourceLine, lines)
    }

    for (const [ index, line ] of originalText.split("\n").entries()) {
        const trimmed = line.trim()

        if (!trimmed.startsWith("return ") && trimmed !== "return") {
            continue
        }

        const mapped = generatedLinesOf.get(index)

        if (mapped === undefined) {
            missing.push(`${index + 1} (unreachable)`)
        } else if (!mapped.some((generatedLine) => (generatedLines[generatedLine] ?? "").includes("return"))) {
            missing.push(`${index + 1} (maps only to generated lines without \`return\`: ${mapped.join(", ")})`)
        }
    }

    t.equal(
        missing.length,
        0,
        `${description}: every original \`return\` line reaches a generated \`return\`` +
            (missing.length > 0 ? `; offenders: ${missing.join("; ")}` : "")
    )
}

// ---------------------------------------------------------------------------
// Fixture plumbing

const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

async function buildFixture(t: Test, compilerOptions: Record<string, unknown>): Promise<TypeScriptFixture> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions,
        sourceFiles            : [
            { fileName: "source.ts", text: sourceText },
            { fileName: "plain.ts", text: plainText }
        ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    return fixture
}

async function readOutput(fixture: TypeScriptFixture, fileName: string): Promise<string> {
    return readFile(path.join(fixture.directory, fileName), "utf8")
}

// ---------------------------------------------------------------------------

it("the emitted .js.map composes back to exact original positions", async (t: Test) => {
    const fixture = await buildFixture(t, { sourceMap: true })

    const jsText  = await readOutput(fixture, "dist/source.js")
    const map     = JSON.parse(await readOutput(fixture, "dist/source.js.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "js.map", decoded, sourceText)
    assertArtifactTokensUnmapped(t, "js.map", decoded, jsText)
    assertReturnLinesCovered(t, "js.map", decoded, sourceText, jsText)

    // A mixin method declaration and a statement inside its body.
    assertExactMapping(t, "mixin method name", decoded, jsText, "greet() {", sourceText, "greet(): string {")
    assertExactMapping(t, "mixin method body", decoded, jsText, "hello ${", sourceText, "hello ${", "hello ${".length)

    // The consumer's method — the recon's max-drift zone (mapped past EOF before the fix).
    assertExactMapping(t, "consumer method name", decoded, jsText, "describe() {", sourceText, "describe(): string {")
    assertExactMapping(t, "consumer method body", decoded, jsText, "${this.greet()", sourceText, "${this.greet()", 2)

    // A field initializer hoisted into the generated constructor still maps to the field.
    assertExactMapping(t, "hoisted field initializer", decoded, jsText, "this.tag = ", sourceText, "tag: string = ")

    // tsc's own convention for a SYNTHESIZED constructor is to map it onto the class node —
    // for the consumer that survives composition as the user's class header (the printed
    // header line maps the original one verbatim)...
    assertExactMapping(
        t, "synthesized consumer constructor -> class header", decoded,
        jsText, "constructor() {\n        super", sourceText, "class Consumer extends "
    )
    // ...while the mixin's INNER class header is generated (`class __Greeter$class`), so
    // the same convention would pin generated code to a user line — dropped instead.
    assertUnmapped(t, "mixin inner-class synthesized constructor", decoded, jsText, "constructor() {\n            super")

    // Trailing statements after the LAST generated insertion.
    assertExactMapping(t, "trailing call", decoded, jsText, "one.describe()", sourceText, "one.describe()", "one.".length)
    assertExactMapping(t, "trailing export", decoded, jsText, "const afterAll = ", sourceText, "const afterAll: ", "const ".length)

    await fixture.dispose()
})

it("an untouched file emits .js and .js.map byte-identical to a plugin-less build", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [
            { fileName: "source.ts", text: sourceText },
            { fileName: "plain.ts", text: plainText }
        ],
        extraFiles : [
            {
                fileName : "tsconfig.plain.json",
                text     : JSON.stringify({
                    compilerOptions : {
                        target                  : "ES2022",
                        module                  : "ESNext",
                        moduleResolution        : "Bundler",
                        lib                     : [ "ES2022", "DOM" ],
                        useDefineForClassFields : false,
                        skipLibCheck            : true,
                        outDir                  : "dist-plain",
                        sourceMap               : true,
                        strict                  : true,
                        experimentalDecorators  : true
                    },
                    files : [ "plain.ts" ]
                }, null, 4)
            }
        ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `plugin build succeeds.\n${commandOutput(build)}`)

    const baseline = await runCommand("node", [ tscBin, "-p", "tsconfig.plain.json" ], fixture.directory)

    t.equal(baseline.exitCode, 0, `plugin-less baseline build succeeds.\n${commandOutput(baseline)}`)

    t.equal(
        await readOutput(fixture, "dist/plain.js"),
        await readOutput(fixture, "dist-plain/plain.js"),
        "untouched .js is byte-identical to the plugin-less build"
    )
    t.equal(
        await readOutput(fixture, "dist/plain.js.map"),
        await readOutput(fixture, "dist-plain/plain.js.map"),
        "untouched .js.map is byte-identical to the plugin-less build"
    )

    await fixture.dispose()
})

it("inlineSourceMap + inlineSources compose the inline map and embed the ORIGINAL text", async (t: Test) => {
    const fixture = await buildFixture(t, { inlineSourceMap: true, inlineSources: true })

    const jsText = await readOutput(fixture, "dist/source.js")
    const marker = "//# sourceMappingURL=data:application/json;base64,"
    const at     = jsText.lastIndexOf(marker)

    t.true(at >= 0, "the emitted .js carries an inline source map")

    const map     = JSON.parse(
        Buffer.from(jsText.slice(at + marker.length).trim(), "base64").toString("utf8")
    ) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "inline map", decoded, sourceText)
    assertArtifactTokensUnmapped(t, "inline map", decoded, jsText)
    assertExactMapping(t, "inline trailing export", decoded, jsText, "const afterAll = ", sourceText, "const afterAll: ", "const ".length)

    t.equal(map.sourcesContent?.length, 1, "sourcesContent carries one entry")
    t.equal(map.sourcesContent?.[0], sourceText, "sourcesContent embeds the ORIGINAL source text, not the reprint")

    await fixture.dispose()
})

// tsc's synthesized-token conventions the corpus stress discovered, pinned on a controlled
// fixture: an accessor's `get`/`set` maps onto its `override` modifier, and declaration
// emit for a class extending an EXPRESSION (the runtime mixin chain) synthesizes
// `declare const <Class>_base` mapped onto the class header / user base name.
const conventionsText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Stored {
        backing: number = 0

        get value(): number {
            return this.backing
        }

        set value(next: number) {
            this.backing = next
        }
    }

    export class Widget extends Base implements Stored {
        override get value(): number {
            return super.value * 2
        }

        override set value(next: number) {
            super.value = next
        }
    }

    export class Plain extends Base {
        public label: string = ""
    }

    export const widget = Widget.new({})
`)

it("tsc's synthesized-token conventions survive the composition", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true, declaration: true, declarationMap: true },
        sourceFiles            : [ { fileName: "conventions.ts", text: conventionsText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    const jsText = await readOutput(fixture, "dist/conventions.js")
    const jsMap  = JSON.parse(await readOutput(fixture, "dist/conventions.js.map")) as SourceMapJson
    const jsSeg  = decodeSegments(jsMap.mappings)

    assertSegmentsWithinOriginal(t, "conventions js.map", jsSeg, conventionsText)
    assertArtifactTokensUnmapped(t, "conventions js.map", jsSeg, jsText)

    // The mixin's own accessors map verbatim...
    assertExactMapping(
        t, "mixin getter", jsSeg,
        jsText, "get value() {\n            return this.backing", conventionsText, "get value(): number {\n        return this.backing"
    )
    // ...and the consumer's `override get` maps its `get` token onto the `override`
    // modifier — the accessor node's start, tsc's own convention.
    assertExactMapping(
        t, "override getter -> its override modifier", jsSeg,
        jsText, "get value() {\n        return super", conventionsText, "override get value"
    )

    const dtsText = await readOutput(fixture, "dist/conventions.d.ts")
    const dtsMap  = JSON.parse(await readOutput(fixture, "dist/conventions.d.ts.map")) as SourceMapJson
    const dtsSeg  = decodeSegments(dtsMap.mappings)

    assertSegmentsWithinOriginal(t, "conventions d.ts.map", dtsSeg, conventionsText)

    // The construction direct-`new` ban brands the base as an EXPRESSION, so declaration
    // emit synthesizes `declare const Plain_base` — tsc's own convention for expression
    // bases, discovered by the corpus stress and pinned here.
    t.true(dtsText.includes("declare const Plain_base"), `d.ts synthesizes the expression base:\n${dtsText}`)

    // The synthesized `declare const Plain_base` statement anchors on the generated
    // branded base EXPRESSION, which has no verbatim original token — dropped...
    assertUnmapped(t, "synthesized d.ts expression base statement", dtsSeg, dtsText, "declare const Plain_base")
    // ...while the `extends Plain_base` reference maps onto the user's own base name.
    assertExactMapping(
        t, "d.ts expression-base reference -> user base name", dtsSeg,
        dtsText, "extends Plain_base", conventionsText, "Plain extends Base {", "extends ".length, "Plain extends ".length
    )

    await fixture.dispose()
})

it("the emitted .d.ts.map composes back to exact original positions", async (t: Test) => {
    const fixture = await buildFixture(t, { sourceMap: true, declaration: true, declarationMap: true })

    const dtsText = await readOutput(fixture, "dist/source.d.ts")
    const map     = JSON.parse(await readOutput(fixture, "dist/source.d.ts.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "d.ts.map", decoded, sourceText)

    // The only exported declaration sits AFTER every generated insertion (max drift zone).
    assertExactMapping(t, "declaration of afterAll", decoded, dtsText, "afterAll: ", sourceText, "afterAll: ")

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// An EXPORTED consumer fills the .d.ts with the full generated machinery: the
// `__Consumer$base` / `__Consumer$base_base` heritage chain, the `static new` signature and
// the exported `<Name>Config` alias. None of those generated tokens may map onto a user
// line — the observed leak was the `extends __Consumer$base_base` value anchoring onto the
// mixin's closing `}` through a collapsed gap-range entry (its printed position starts no
// identifier, so the token-agreement check alone could not reject it).

const exportedConsumerText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Greeter {
        public name: string = "Ada"

        greet(): string {
            return \`hello \${this.name}\`
        }
    }

    export class Consumer extends Base implements Greeter {
        public tag: string = ""

        describe(): string {
            return \`\${this.greet()} [\${this.tag}]\`
        }
    }

    export const one = Consumer.new({ name: "Grace", tag: "x" })
`)

it("generated declarations in an exported consumer's .d.ts carry no source mapping", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true, declaration: true, declarationMap: true },
        sourceFiles            : [ { fileName: "source.ts", text: exportedConsumerText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    const dtsText = await readOutput(fixture, "dist/source.d.ts")
    const map     = JSON.parse(await readOutput(fixture, "dist/source.d.ts.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "exported-consumer d.ts.map", decoded, exportedConsumerText)
    assertArtifactTokensUnmapped(t, "exported-consumer d.ts.map", decoded, dtsText)

    // The generated `static new` signature and the exported Config alias.
    assertUnmapped(t, "static new Config parameter", decoded, dtsText, "ConsumerConfig): Consumer")
    assertUnmapped(t, "exported Config alias", decoded, dtsText, "type ConsumerConfig = ", "type ".length)

    // PUNCTUATION inside the generated declarations — positions that start no identifier
    // are invisible to the token-agreement check, so they leaked onto user `}` lines while
    // their column fitted within the line (the identifier pins above never caught them).
    assertUnmapped(t, "static new opening paren", decoded, dtsText, "new(props?: ConsumerConfig", "new".length)
    assertUnmapped(t, "Config alias type operator", decoded, dtsText, "Partial<Pick<", "Partial".length)

    // ...while a generated position whose mapping lands on the START of a user token is a
    // deliberate derived-from pin and survives: the heritage type argument points at the
    // user's base name, the collision brand at the consumer class statement.
    assertExactMapping(
        t, "generated heritage type argument -> user base name", decoded,
        dtsText, "__Consumer$base<[", exportedConsumerText, "Consumer extends Base", "__Consumer$base".length, "Consumer extends ".length
    )
    assertExactMapping(
        t, "collision brand string -> consumer class statement", decoded,
        dtsText, "\"Static mixin member collision", exportedConsumerText, "export class Consumer"
    )

    // User declarations still map exactly around the generated machinery.
    assertExactMapping(t, "consumer field", decoded, dtsText, "tag: string;", exportedConsumerText, "tag: string = ")
    assertExactMapping(t, "consumer method", decoded, dtsText, "describe(): string;", exportedConsumerText, "describe(): string {")

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// Segment-agreement audit: EVERY mapped segment must agree with the original text — an
// identifier-starting generated position must find the same word at its mapped original
// position (tsc's synthesized-token conventions tolerated), and a punctuation position must
// find the same character (quote style normalized by the printer tolerated). Any
// disagreement is generated code pinned onto a user line. Shapes chosen to exercise the
// distinct machinery: full construction + config alias, machinery-flavoured user words
// (the coincidental-agreement risk), accessors + generics, and a dense single-line file.

const conventionWords = new Set([ "constructor", "declare", "get", "set", "export", "async", "this" ])
const quoteCharacters = new Set([ "\"", "'", "`" ])

function assertSegmentAgreement(
    t: Test,
    description: string,
    segments: DecodedSegment[],
    generatedText: string,
    originalText: string
): void {
    const generatedLines      = generatedText.split("\n")
    const originalLines       = originalText.split("\n")
    const offenders: string[] = []

    for (const segment of segments) {
        if (segment.sourceLine === undefined || segment.sourceCharacter === undefined) {
            continue
        }

        const generatedLine = generatedLines[segment.generatedLine] ?? ""
        const originalLine  = originalLines[segment.sourceLine] ?? ""
        const generatedWord = identifierAtPosition(generatedLine, segment.generatedCharacter)
        const where         = `gen ${segment.generatedLine + 1}:${segment.generatedCharacter} -> ` +
            `src ${segment.sourceLine + 1}:${segment.sourceCharacter}`

        if (generatedWord !== undefined) {
            if (!originalLine.startsWith(generatedWord, segment.sourceCharacter) &&
                !conventionWords.has(generatedWord) && !generatedWord.endsWith("_base")
            ) {
                offenders.push(`${where}: generated word ${JSON.stringify(generatedWord)} vs original ` +
                    JSON.stringify(originalLine.slice(segment.sourceCharacter, segment.sourceCharacter + generatedWord.length + 6)))
            }

            continue
        }

        const generatedChar = generatedLine[segment.generatedCharacter]
        const originalChar  = originalLine[segment.sourceCharacter]

        if (generatedChar === undefined || generatedChar.trim() === "" ||
            originalChar === undefined || originalChar.trim() === ""
        ) {
            continue
        }

        // A non-identifier generated position mapping onto the START of a user token is a
        // deliberate derived-from pin (e.g. a generated heritage onto the user's base name).
        if (identifierAtPosition(originalLine, segment.sourceCharacter) !== undefined) {
            continue
        }

        if (generatedChar !== originalChar &&
            !(quoteCharacters.has(generatedChar) && quoteCharacters.has(originalChar))
        ) {
            offenders.push(`${where}: generated char ${JSON.stringify(generatedChar)} vs original ` +
                `${JSON.stringify(originalChar)} on ${JSON.stringify(originalLine.trim().slice(0, 40))}`)
        }
    }

    t.equal(offenders.length, 0, `${description}: every mapped segment agrees with the original text` +
        (offenders.length > 0 ? `; offenders:\n${offenders.join("\n")}` : ""))
}

const identifierCharacterPattern = /[A-Za-z0-9_$À-￿]/

function identifierAtPosition(lineText: string, character: number): string | undefined {
    if (character > 0 && identifierCharacterPattern.test(lineText[character - 1] ?? "")) {
        return undefined
    }

    let end = character

    while (end < lineText.length && identifierCharacterPattern.test(lineText[end])) {
        end += 1
    }

    return end > character ? lineText.slice(character, end) : undefined
}

const coincidenceText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Setup {
        initialize(props?: unknown): void {
            void props
        }

        configure(): string {
            return "mix new base initialize props"
        }
    }

    export class Machine extends Base implements Setup {
        run(): string {
            return this.configure()
        }
    }

    export const machine = Machine.new({})
`)

const accessorGenericText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Holder<V> {
        public stored: V | undefined = undefined

        get value(): V | undefined {
            return this.stored
        }

        set value(next: V | undefined) {
            this.stored = next
        }

        take(): V | undefined {
            return this.stored
        }
    }

    export class Box extends Base implements Holder<number> {
        grab(): number | undefined {
            return this.take()
        }
    }

    export const box = Box.new({})
`)

it("every mapped segment agrees with the original text across machinery shapes", async (t: Test) => {
    const shapes  = [
        { fileName: "exported-construction.ts", text: exportedConsumerText },
        { fileName: "coincidence.ts", text: coincidenceText },
        { fileName: "accessor-generic.ts", text: accessorGenericText },
        { fileName: "dense.ts", text: denseText }
    ]
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true, declaration: true, declarationMap: true },
        sourceFiles            : shapes
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    for (const { fileName, text } of shapes) {
        const stem = fileName.slice(0, -".ts".length)

        for (const kind of [ "js", "d.ts" ] as const) {
            const generated = await readOutput(fixture, `dist/${stem}.${kind}`)
            const map       = JSON.parse(await readOutput(fixture, `dist/${stem}.${kind}.map`)) as SourceMapJson
            const decoded   = decodeSegments(map.mappings)

            assertSegmentsWithinOriginal(t, `${stem}.${kind}.map`, decoded, text)
            assertSegmentAgreement(t, `${stem}.${kind}.map`, decoded, generated, text)
        }
    }

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// Runtime plane: what the user actually debugs with

// A mixin method that throws, reached through a consumer method — Node's
// `--enable-source-maps` must print the ORIGINAL `.ts` positions in the stack.
const throwingText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Thrower {
        boom(): string {
            throw new Error("mixin-boom")
        }
    }

    class Runner extends Base implements Thrower {
        run(): string {
            return this.boom()
        }
    }

    const runner = Runner.new({})

    try {
        runner.run()
    } catch (error) {
        console.log((error as Error).stack)
    }
`)

it("node --enable-source-maps prints original positions in stack traces", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [ { fileName: "throwing.ts", text: throwingText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    const run = await runCommand(
        "node",
        [ "--enable-source-maps", path.join("dist", "throwing.js") ],
        fixture.directory
    )

    t.equal(run.exitCode, 0, `the emitted JS runs.\n${commandOutput(run)}`)

    const stackLines = [ ...run.stdout.matchAll(/throwing\.ts:(\d+):\d+/g) ].map((match) => Number(match[1]))

    t.isGreater(stackLines.length, 0, `the stack is rewritten to the original .ts file.\n${run.stdout}`)

    const throwLine = positionOf(throwingText, "throw new Error").line + 1
    const callLine  = positionOf(throwingText, "return this.boom()").line + 1

    t.true(stackLines.includes(throwLine), `the throw site maps to throwing.ts:${throwLine}.\n${run.stdout}`)
    t.true(stackLines.includes(callLine), `the consumer call site maps to throwing.ts:${callLine}.\n${run.stdout}`)

    // The fixture directory is left for potential re-runs; the OS temp dir is cleaned on exit.
    void fixture
})

// ---------------------------------------------------------------------------
// Same-basename files in different directories: the source<->remap pairing must wire each
// map to ITS OWN file (the pairing involves a base-name check — identical basenames with
// different contents are exactly the case that would expose cross-wiring).

const aliceModelText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class AliceMixin {
        aliceGreet(): string {
            return "alice"
        }
    }

    class AliceUser implements AliceMixin {
        aliceDescribe(): string {
            return super.aliceGreet()
        }
    }

    export const alice: string = new AliceUser().aliceDescribe()
`)

const bobModelText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class BobMixin {
        bobGreet(): string {
            return "bob"
        }
    }

    class BobUser implements BobMixin {
        bobDescribe(): string {
            return super.bobGreet()
        }
    }

    export const bob: string = new BobUser().bobDescribe()
`)

it("two same-named files in different directories each compose against their own source", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [
            { fileName: "a/model.ts", text: aliceModelText },
            { fileName: "b/model.ts", text: bobModelText }
        ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    for (const [ directory, text, needle ] of [
        [ "a", aliceModelText, "aliceGreet() {" ],
        [ "b", bobModelText, "bobGreet() {" ]
    ] as const) {
        const jsText  = await readOutput(fixture, `dist/${directory}/model.js`)
        const map     = JSON.parse(await readOutput(fixture, `dist/${directory}/model.js.map`)) as SourceMapJson
        const decoded = decodeSegments(map.mappings)

        assertSegmentsWithinOriginal(t, `${directory}/model.js.map`, decoded, text)
        assertReturnLinesCovered(t, `${directory}/model.js.map`, decoded, text, jsText)
        assertExactMapping(
            t, `${directory}/model.js.map method`, decoded,
            jsText, needle, text, needle.replace("() {", "(): string {")
        )
    }

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// Drift zones BETWEEN insertions: several mixins/consumers interleaved with plain user
// code, plus a consumer nested inside a function body. The single-mixin fixture above only
// exercises the tail; here every gap between generated insertions is pinned.

const multiText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class First {
        firstHello(): string {
            return "first"
        }
    }

    export function between(): string {
        return "between"
    }

    @mixin()
    class Second implements First {
        secondHello(): string {
            return \`second \${super.firstHello()}\`
        }
    }

    class MidConsumer extends Base implements Second {
        midway(): string {
            return this.secondHello()
        }
    }

    export function wrapper(): string {
        class Inner extends Base implements First {
            innerHello(): string {
                return \`inner \${this.firstHello()}\`
            }
        }

        return Inner.new({}).innerHello()
    }

    export const finale: string = wrapper() + MidConsumer.new({}).midway()
`)

it("statements between generated insertions map exactly (multi-mixin file)", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [ { fileName: "multi.ts", text: multiText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    const jsText  = await readOutput(fixture, "dist/multi.js")
    const map     = JSON.parse(await readOutput(fixture, "dist/multi.js.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "multi js.map", decoded, multiText)
    assertArtifactTokensUnmapped(t, "multi js.map", decoded, jsText)
    assertReturnLinesCovered(t, "multi js.map", decoded, multiText, jsText)

    // Between the first and second insertions.
    assertExactMapping(t, "function between insertions", decoded, jsText, 'return "between"', multiText, 'return "between"')
    // Between the second insertion and the consumer.
    assertExactMapping(t, "second mixin method", decoded, jsText, "secondHello() {", multiText, "secondHello(): string {")
    // The mid-file consumer.
    assertExactMapping(t, "mid-file consumer body", decoded, jsText, "return this.secondHello()", multiText, "return this.secondHello()")
    // The consumer NESTED inside a function body.
    assertExactMapping(t, "nested consumer method", decoded, jsText, "innerHello() {", multiText, "innerHello(): string {")
    assertExactMapping(t, "nested consumer construction", decoded, jsText, "Inner.new({}).innerHello()", multiText, "Inner.new({}).innerHello()")
    // The tail after the LAST insertion.
    assertExactMapping(t, "trailing finale", decoded, jsText, "const finale = ", multiText, "const finale: ", "const ".length)

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// Unicode: CJK identifiers do not match the ASCII identifier pattern of the
// token-agreement filter, so their mappings ride on position arithmetic alone; emoji take
// two UTF-16 units; the inline-map variant round-trips non-ASCII text through base64.

const unicodeText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class 问候 {
        名字: string = "Ada"

        打招呼(): string {
            return \`你好 🎉 \${this.名字}\`
        }
    }

    class 客人 extends Base implements 问候 {
        自我介绍(): string {
            return \`🚀 \${this.打招呼()}\`
        }
    }

    export const 结果: string = 客人.new({}).自我介绍()
`)

it("CJK identifiers and emoji strings map exactly", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [ { fileName: "unicode.ts", text: unicodeText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    const jsText  = await readOutput(fixture, "dist/unicode.js")
    const map     = JSON.parse(await readOutput(fixture, "dist/unicode.js.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "unicode js.map", decoded, unicodeText)
    assertArtifactTokensUnmapped(t, "unicode js.map", decoded, jsText)
    assertReturnLinesCovered(t, "unicode js.map", decoded, unicodeText, jsText)

    assertExactMapping(t, "CJK mixin method", decoded, jsText, "打招呼() {", unicodeText, "打招呼(): string {")
    assertExactMapping(t, "emoji template body", decoded, jsText, "你好 🎉 ${", unicodeText, "你好 🎉 ${", "你好 🎉 ${".length)
    assertExactMapping(t, "CJK consumer method", decoded, jsText, "自我介绍() {", unicodeText, "自我介绍(): string {")
    assertExactMapping(t, "CJK trailing export", decoded, jsText, "const 结果 = ", unicodeText, "const 结果: ", "const ".length)

    await fixture.dispose()
})

it("the inline map round-trips non-ASCII sources through base64", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { inlineSourceMap: true, inlineSources: true },
        sourceFiles            : [ { fileName: "unicode.ts", text: unicodeText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    const jsText = await readOutput(fixture, "dist/unicode.js")
    const marker = "//# sourceMappingURL=data:application/json;base64,"
    const at     = jsText.lastIndexOf(marker)

    t.true(at >= 0, "the emitted .js carries an inline source map")

    const map     = JSON.parse(
        Buffer.from(jsText.slice(at + marker.length).trim(), "base64").toString("utf8")
    ) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "unicode inline map", decoded, unicodeText)
    t.equal(map.sourcesContent?.[0], unicodeText, "sourcesContent embeds the ORIGINAL non-ASCII text")
    assertExactMapping(t, "inline CJK export", decoded, jsText, "const 结果 = ", unicodeText, "const 结果: ", "const ".length)

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// CRLF line endings: the reprint normalizes newlines, but columns and line numbers of the
// composed map must stay in the CRLF file's own coordinates.

it("a CRLF source file maps exactly", async (t: Test) => {
    const crlfText = sourceText.replace(/\n/g, "\r\n")
    const fixture  = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [ { fileName: "crlf.ts", text: crlfText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    const jsText  = await readOutput(fixture, "dist/crlf.js")
    const map     = JSON.parse(await readOutput(fixture, "dist/crlf.js.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "crlf js.map", decoded, crlfText)
    assertReturnLinesCovered(t, "crlf js.map", decoded, crlfText, jsText)

    assertExactMapping(t, "crlf mixin method", decoded, jsText, "greet() {", crlfText, "greet(): string {")
    assertExactMapping(t, "crlf consumer method", decoded, jsText, "describe() {", crlfText, "describe(): string {")
    assertExactMapping(t, "crlf trailing export", decoded, jsText, "const afterAll = ", crlfText, "const afterAll: ", "const ".length)

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// The NodeNext plane (the Bundler-default suite was once structurally blind to it) and
// declaration-only emit — both must compose the same way.

it("a NodeNext (type: module) build composes its maps the same way", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { module: "NodeNext", moduleResolution: "NodeNext", sourceMap: true },
        sourceFiles            : [ { fileName: "source.ts", text: sourceText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `NodeNext build succeeds.\n${commandOutput(build)}`)

    const jsText  = await readOutput(fixture, "dist/source.js")
    const map     = JSON.parse(await readOutput(fixture, "dist/source.js.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "NodeNext js.map", decoded, sourceText)
    assertReturnLinesCovered(t, "NodeNext js.map", decoded, sourceText, jsText)
    assertExactMapping(t, "NodeNext consumer method", decoded, jsText, "describe() {", sourceText, "describe(): string {")
    assertExactMapping(t, "NodeNext trailing export", decoded, jsText, "const afterAll = ", sourceText, "const afterAll: ", "const ".length)

    await fixture.dispose()
})

it("declaration-only emit composes the .d.ts.map", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { declaration: true, declarationMap: true, emitDeclarationOnly: true },
        sourceFiles            : [ { fileName: "source.ts", text: sourceText } ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `declaration-only build succeeds.\n${commandOutput(build)}`)

    const dtsText = await readOutput(fixture, "dist/source.d.ts")
    const map     = JSON.parse(await readOutput(fixture, "dist/source.d.ts.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "declaration-only d.ts.map", decoded, sourceText)
    assertExactMapping(t, "declaration-only afterAll", decoded, dtsText, "afterAll: ", sourceText, "afterAll: ")

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// Text-shape edges: a BOM (tsc strips it — map coordinates are relative to the stripped
// text), a shebang (tsc PRESERVES it as the output's first line, shifting every generated
// line), a file ending WITHOUT a trailing newline (the EOF boundary — the original bug's
// beyond-EOF plane), and a whole mixin+consumer packed onto ONE line (same-line anchoring
// with the column caps doing all the work). One fixture, one build, per-file maps.

const denseText = [
    `import { mixin } from "ts-mixin-class"`,
    `import { Base } from "ts-mixin-class/base"`,
    `@mixin() class Greeter { greet(): string { return "hi" } } export class Consumer extends Base implements Greeter { use(): string { return this.greet() + "!" } }`,
    ``
].join("\n")

it("BOM, shebang, missing EOF newline and a single-line source all map exactly", async (t: Test) => {
    const shebangText = `#!/usr/bin/env node\n${sourceText}`
    const noEofText   = sourceText.trimEnd()
    const fixture     = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [
            { fileName: "bom.ts", text: `\uFEFF${sourceText}` },
            { fileName: "shebang.ts", text: shebangText },
            { fileName: "noeof.ts", text: noEofText },
            { fileName: "dense.ts", text: denseText }
        ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `build succeeds.\n${commandOutput(build)}`)

    // BOM: stripped before parsing, so the map is relative to the BOM-less text.
    const bomJs  = await readOutput(fixture, "dist/bom.js")
    const bomMap = decodeSegments((JSON.parse(await readOutput(fixture, "dist/bom.js.map")) as SourceMapJson).mappings)

    assertSegmentsWithinOriginal(t, "BOM js.map", bomMap, sourceText)
    assertReturnLinesCovered(t, "BOM js.map", bomMap, sourceText, bomJs)
    assertExactMapping(t, "BOM consumer method", bomMap, bomJs, "describe() {", sourceText, "describe(): string {")
    assertExactMapping(t, "BOM trailing export", bomMap, bomJs, "const afterAll = ", sourceText, "const afterAll: ", "const ".length)

    // Shebang: kept as line 0 of the output, so every generated line is shifted by one —
    // and the original positions include the shebang line too.
    const shebangJs  = await readOutput(fixture, "dist/shebang.js")
    const shebangMap = decodeSegments((JSON.parse(await readOutput(fixture, "dist/shebang.js.map")) as SourceMapJson).mappings)

    t.true(shebangJs.startsWith("#!/usr/bin/env node\n"), "the shebang survives as the output's first line")
    assertSegmentsWithinOriginal(t, "shebang js.map", shebangMap, shebangText)
    assertReturnLinesCovered(t, "shebang js.map", shebangMap, shebangText, shebangJs)
    assertExactMapping(t, "shebang mixin body", shebangMap, shebangJs, "hello ${", shebangText, "hello ${", "hello ${".length)
    assertExactMapping(t, "shebang trailing export", shebangMap, shebangJs, "const afterAll = ", shebangText, "const afterAll: ", "const ".length)

    // No trailing newline: the max-drift zone ends exactly AT the unterminated last line.
    const noEofJs  = await readOutput(fixture, "dist/noeof.js")
    const noEofMap = decodeSegments((JSON.parse(await readOutput(fixture, "dist/noeof.js.map")) as SourceMapJson).mappings)

    assertSegmentsWithinOriginal(t, "no-EOF-newline js.map", noEofMap, noEofText)
    assertReturnLinesCovered(t, "no-EOF-newline js.map", noEofMap, noEofText, noEofJs)
    assertExactMapping(t, "no-EOF-newline trailing export", noEofMap, noEofJs, "const afterAll = ", noEofText, "const afterAll: ", "const ".length)

    // Dense single line: the mixin body, the generated machinery and the consumer all
    // translate through ONE printed line — the same-line column caps carry everything.
    const denseJs  = await readOutput(fixture, "dist/dense.js")
    const denseMap = decodeSegments((JSON.parse(await readOutput(fixture, "dist/dense.js.map")) as SourceMapJson).mappings)

    assertSegmentsWithinOriginal(t, "dense js.map", denseMap, denseText)
    assertArtifactTokensUnmapped(t, "dense js.map", denseMap, denseJs)
    assertExactMapping(t, "dense mixin return", denseMap, denseJs, `"hi"`, denseText, `"hi"`)
    assertExactMapping(t, "dense consumer return", denseMap, denseJs, `this.greet() + "!"`, denseText, `this.greet() + "!"`)

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// `outFile` bundling: ONE map whose `sources` lists every input — two of them reprinted.
// This is the only shape where `resolveSourceRemaps` pairs multiple remaps inside a single
// map (positional + base-name matching), so each source's segments must translate against
// its OWN original, and none may leak into a neighbour's coordinates.

it("an outFile bundle composes every reprinted source inside the single map", async (t: Test) => {
    const betaText = trimIndent(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class Tagger {
            label(): string {
                return "tag"
            }
        }

        export class Item extends Base implements Tagger {
            show(): string {
                return this.label()
            }
        }
    `)
    const fixture  = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : {
            // `outFile` needs a non-ES module kind, which in turn needs the pre-Bundler
            // resolution — both deprecated in TS 6, but still emitting. The subpath import
            // resolves via `paths` because node10 resolution cannot read `exports` maps.
            ignoreDeprecations : "6.0",
            module             : "AMD",
            moduleResolution   : "Node10",
            outFile            : "dist/bundle.js",
            outDir             : undefined,
            sourceMap          : true,
            baseUrl            : ".",
            paths              : {
                "ts-mixin-class"      : [ "node_modules/ts-mixin-class/dist/src/index.d.ts" ],
                "ts-mixin-class/base" : [ "node_modules/ts-mixin-class/dist/src/base.d.ts" ]
            }
        },
        sourceFiles : [
            { fileName: "plain.ts", text: plainText },
            { fileName: "alpha.ts", text: sourceText },
            { fileName: "beta.ts", text: betaText }
        ]
    })

    const build = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(build.exitCode, 0, `outFile build succeeds.\n${commandOutput(build)}`)

    const jsText    = await readOutput(fixture, "dist/bundle.js")
    const map       = JSON.parse(await readOutput(fixture, "dist/bundle.js.map")) as SourceMapJson
    const decoded   = decodeSegments(map.mappings)
    const originals = new Map<number, { label: string, text: string }>()

    for (const [ index, source ] of map.sources.entries()) {
        const text = source.endsWith("plain.ts") ? plainText
            : source.endsWith("alpha.ts") ? sourceText
                : source.endsWith("beta.ts") ? betaText
                    : undefined

        t.true(text !== undefined, `map source ${JSON.stringify(source)} is one of the inputs`)

        if (text !== undefined) {
            originals.set(index, { label: baseNameOf(source), text })
        }
    }

    t.equal(map.sources.length, 3, "the bundle map lists all three inputs")

    for (const [ index, original ] of originals) {
        const ownSegments = decoded.filter((segment) => segment.sourceIndex === index)

        assertSegmentsWithinOriginal(t, `bundle map / ${original.label}`, ownSegments, original.text)
        assertReturnLinesCovered(t, `bundle map / ${original.label}`, ownSegments, original.text, jsText)
    }

    assertArtifactTokensUnmapped(t, "bundle map", decoded, jsText)
    assertExactMapping(t, "bundle plain body", decoded, jsText, "value * 2", plainText, "value * 2")
    assertExactMapping(t, "bundle alpha consumer body", decoded, jsText, "${this.greet()", sourceText, "${this.greet()", 2)
    assertExactMapping(t, "bundle beta consumer body", decoded, jsText, "this.label()", betaText, "this.label()")

    await fixture.dispose()
})

function baseNameOf(fileName: string): string {
    return fileName.slice(fileName.lastIndexOf("/") + 1)
}

// ---------------------------------------------------------------------------
// `incremental`: the `.tsbuildinfo` travels through the same composing `writeFile` as the
// maps and must pass through unscathed, and a rebuild after an edit must compose against
// the EDITED text (the builder reuses program state; the remap must not go stale).

it("an incremental rebuild composes the map and keeps .tsbuildinfo intact", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true, incremental: true, tsBuildInfoFile: "dist/build.tsbuildinfo" },
        sourceFiles            : [ { fileName: "source.ts", text: sourceText } ]
    })

    const firstBuild = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(firstBuild.exitCode, 0, `first incremental build succeeds.\n${commandOutput(firstBuild)}`)
    t.true(
        JSON.parse(await readOutput(fixture, "dist/build.tsbuildinfo")) !== null,
        "the .tsbuildinfo written through the composing writeFile is valid JSON"
    )

    const editedText = `// edited\n\n${sourceText}`

    await writeFile(path.join(fixture.directory, "source.ts"), editedText)

    const secondBuild = await runCommand("node", [ tscBin, "-p", fixture.tsconfigFile ], fixture.directory)

    t.equal(secondBuild.exitCode, 0, `incremental rebuild succeeds.\n${commandOutput(secondBuild)}`)

    const jsText  = await readOutput(fixture, "dist/source.js")
    const map     = JSON.parse(await readOutput(fixture, "dist/source.js.map")) as SourceMapJson
    const decoded = decodeSegments(map.mappings)

    assertSegmentsWithinOriginal(t, "incremental rebuild js.map", decoded, editedText)
    assertReturnLinesCovered(t, "incremental rebuild js.map", decoded, editedText, jsText)
    assertExactMapping(t, "incremental rebuild consumer method", decoded, jsText, "describe() {", editedText, "describe(): string {")
    assertExactMapping(t, "incremental rebuild trailing export", decoded, jsText, "const afterAll = ", editedText, "const afterAll: ", "const ".length)

    await fixture.dispose()
})

// ---------------------------------------------------------------------------
// Watch mode: after an edit, the SECOND build's map must compose against the EDITED text —
// a stale remap kept from the first program would shift every position below the edit.

it("a tsc --watch rebuild composes the map against the edited text", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : true,
        compilerOptions        : { sourceMap: true },
        sourceFiles            : [ { fileName: "watched.ts", text: sourceText } ]
    })
    const watch   = startTscWatch(fixture.directory, fixture.tsconfigFile, { emit: true })

    try {
        await watch.waitForBuild()

        const firstMap = JSON.parse(await readOutput(fixture, "dist/watched.js.map")) as SourceMapJson
        const firstJs  = await readOutput(fixture, "dist/watched.js")

        assertSegmentsWithinOriginal(t, "watch first build", decodeSegments(firstMap.mappings), sourceText)
        assertExactMapping(
            t, "watch first build consumer method", decodeSegments(firstMap.mappings),
            firstJs, "describe() {", sourceText, "describe(): string {"
        )

        // Shift every line below the top by two, and grow the mixin body by one statement —
        // both the whole-file offset and an intra-class shift must land in the new map.
        const editedText = `// edited\n\n${sourceText}`.replace(
            "greet(): string {",
            "greet(): string {\n        void 0"
        )

        await writeFile(path.join(fixture.directory, "watched.ts"), editedText)
        await watch.waitForBuild()

        const secondMap = JSON.parse(await readOutput(fixture, "dist/watched.js.map")) as SourceMapJson
        const secondJs  = await readOutput(fixture, "dist/watched.js")
        const decoded   = decodeSegments(secondMap.mappings)

        assertSegmentsWithinOriginal(t, "watch rebuild", decoded, editedText)
        assertReturnLinesCovered(t, "watch rebuild", decoded, editedText, secondJs)
        assertExactMapping(t, "watch rebuild mixin body", decoded, secondJs, "hello ${", editedText, "hello ${", "hello ${".length)
        assertExactMapping(t, "watch rebuild consumer method", decoded, secondJs, "describe() {", editedText, "describe(): string {")
        assertExactMapping(t, "watch rebuild trailing export", decoded, secondJs, "const afterAll = ", editedText, "const afterAll: ", "const ".length)
    } finally {
        watch.dispose()
    }

    await fixture.dispose()
})
