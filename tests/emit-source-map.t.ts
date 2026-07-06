import { readFile } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

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
