import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { transformSourceFile } from "../src/index.js"
import { createSourceFile, trimIndent } from "./util.js"

type SourceSpan = {
    pos : number,
    end : number,
    start : number,
    finish : number,
    text : string
}

type StableSignatureCollection = {
    counts : Map<string, number>,
    syntheticOutsideGeneratedNodes : string[],
    total : number
}

const sourceText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class Before {
        beforeMethod(): string {
            return "before"
        }
    }

    @mixin()
    class SourceClass<T> {
        value: string = "value"

        passThrough(a: T): T {
            return a
        }
    }

    class Consumer<T> implements SourceClass<T> {
        ownMethod(): string {
            return "own"
        }
    }

    class After {
        afterMethod(): string {
            return "after"
        }
    }
`)

it("preserves source positions outside generated mixin declarations", async (t: Test) => {
    const originalSourceFile    = createSourceFile("source.ts", sourceText)
    const transformedSourceFile = transformSourceFile(ts, originalSourceFile)
    const replacedRanges        = collectOriginalReplacedRanges(originalSourceFile, [ "SourceClass" ])
    const originalStable        = collectStableSignatures(originalSourceFile, originalSourceFile, replacedRanges)
    const transformedStable     = collectStableSignatures(transformedSourceFile, transformedSourceFile, replacedRanges)
    const missingOriginal       = subtractSignatureCounts(originalStable.counts, transformedStable.counts)
    const unexpectedTransformed = subtractSignatureCounts(transformedStable.counts, originalStable.counts)

    t.expect(topLevelStatementSignatures(transformedSourceFile)).toEqual([
        "ImportDeclaration <import>",
        "ImportDeclaration <import>",
        "ClassDeclaration Before",
        "InterfaceDeclaration SourceClass",
        "VariableStatement __SourceClass$mixin",
        "VariableStatement SourceClass",
        "ClassDeclaration __Consumer$empty",
        "InterfaceDeclaration __Consumer$base",
        "ClassDeclaration __Consumer$base",
        "ClassDeclaration Consumer",
        "ClassDeclaration After"
    ])

    t.true(replacedRanges.length > 0, "Fixture has an original mixin declaration range")
    t.equal(transformedSourceFile.text, originalSourceFile.text, "Transformed SourceFile keeps the original source text")
    t.equal(originalStable.total, transformedStable.total, "Stable node count matches")
    t.expect(missingOriginal).toEqual([])
    t.expect(unexpectedTransformed).toEqual([])
    t.expect(transformedStable.syntheticOutsideGeneratedNodes).toEqual([])
})

function topLevelStatementSignatures(sourceFile: ts.SourceFile): string[] {
    return sourceFile.statements.map((statement) => {
        return `${statementKindName(statement)} ${statementLabel(statement)}`
    })
}

function statementKindName(statement: ts.Statement): string {
    if (ts.isVariableStatement(statement)) {
        return "VariableStatement"
    }

    return ts.SyntaxKind[statement.kind]
}

function statementLabel(statement: ts.Statement): string {
    if (ts.isImportDeclaration(statement)) {
        return "<import>"
    }

    if ((ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name !== undefined) {
        return statement.name.text
    }

    if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations[0]

        if (declaration !== undefined && ts.isIdentifier(declaration.name)) {
            return declaration.name.text
        }
    }

    return "<none>"
}

function collectOriginalReplacedRanges(sourceFile: ts.SourceFile, classNames: string[]): SourceSpan[] {
    const names = new Set(classNames)

    return sourceFile.statements
        .filter((statement): statement is ts.ClassDeclaration => {
            return ts.isClassDeclaration(statement) &&
                statement.name !== undefined &&
                names.has(statement.name.text)
        })
        .map((statement) => expandRangeToLeadingDecorators(sourceFile, nodeSpan(statement, sourceFile)))
}

function collectStableSignatures(
    root: ts.Node,
    sourceFile: ts.SourceFile,
    excludedRanges: SourceSpan[]
): StableSignatureCollection {
    const counts                         = new Map<string, number>()
    const syntheticOutsideGeneratedNodes : string[] = []
    let total                            = 0

    const visit = (node: ts.Node): void => {
        if (node !== root && isSynthetic(node)) {
            return
        }

        const span = sourceSpan(node, sourceFile)

        if (span === undefined) {
            syntheticOutsideGeneratedNodes.push(formatNodeLine(node, sourceFile))
            ts.forEachChild(node, visit)
            return
        }

        if (node.kind !== ts.SyntaxKind.SourceFile &&
            (isInsideAnyRange(span, excludedRanges) || isGeneratedInsertionNode(node))) {
            return
        }

        const signature = nodeSignature(node, sourceFile)

        counts.set(signature, (counts.get(signature) ?? 0) + 1)
        total += 1

        ts.forEachChild(node, visit)
    }

    visit(root)

    return {
        counts,
        syntheticOutsideGeneratedNodes,
        total
    }
}

function isSynthetic(node: ts.Node): boolean {
    return node.pos < 0 || node.end < 0
}

function isGeneratedInsertionNode(node: ts.Node): boolean {
    if (ts.isVariableStatement(node)) {
        const declaration = node.declarationList.declarations[0]

        return declaration !== undefined &&
            ts.isIdentifier(declaration.name) &&
            (declaration.name.text.endsWith("$mixin") || declaration.name.text === "SourceClass")
    }

    if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name !== undefined) {
        return node.name.text.endsWith("$base") || node.name.text.endsWith("$empty")
    }

    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword) {
        return true
    }

    return false
}

function subtractSignatureCounts(left: Map<string, number>, right: Map<string, number>): string[] {
    const result: string[] = []

    for (const [ signature, count ] of left) {
        const missingCount = count - (right.get(signature) ?? 0)

        for (let index = 0; index < missingCount; index += 1) {
            result.push(signature)
        }
    }

    return result
}

function expandRangeToLeadingDecorators(sourceFile: ts.SourceFile, range: SourceSpan): SourceSpan {
    const decoratorStart = findLeadingDecoratorStart(sourceFile.text, range.start)

    if (decoratorStart === undefined) {
        return range
    }

    const pos = findTriviaStartBefore(sourceFile.text, decoratorStart)

    return {
        ...range,
        pos,
        start : decoratorStart,
        text  : sourceFile.text.slice(decoratorStart, range.finish).replaceAll("\n", "\\n")
    }
}

function findLeadingDecoratorStart(text: string, position: number): number | undefined {
    let lineStart      = text.lastIndexOf("\n", position - 1) + 1
    let decoratorStart : number | undefined = undefined

    while (lineStart > 0) {
        const previousLineEnd   = lineStart - 1
        const previousLineStart = text.lastIndexOf("\n", previousLineEnd - 1) + 1
        const previousLine      = text.slice(previousLineStart, previousLineEnd)
        const indentLength      = previousLine.match(/^\s*/)?.[0].length ?? 0
        const firstToken        = previousLineStart + indentLength

        if (previousLine.trim() === "" || text[firstToken] !== "@") {
            break
        }

        decoratorStart = firstToken
        lineStart      = previousLineStart
    }

    return decoratorStart
}

function findTriviaStartBefore(text: string, position: number): number {
    let triviaStart = position

    while (triviaStart > 0 && /\s/.test(text[triviaStart - 1])) {
        triviaStart -= 1
    }

    return triviaStart
}

function nodeSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
    const span = nodeSpan(node, sourceFile)

    return [
        ts.SyntaxKind[node.kind],
        nodeLabel(node),
        span.pos,
        span.end,
        span.start,
        span.finish,
        JSON.stringify(span.text)
    ].join(" | ")
}

function sourceSpan(node: ts.Node, sourceFile: ts.SourceFile): SourceSpan | undefined {
    if (isSynthetic(node)) {
        return undefined
    }

    return nodeSpan(node, sourceFile)
}

function nodeSpan(node: ts.Node, sourceFile: ts.SourceFile): SourceSpan {
    const start  = node.getStart(sourceFile)
    const finish = node.getEnd()

    return {
        pos  : node.pos,
        end  : node.end,
        start,
        finish,
        text : sourceFile.text.slice(start, finish).replaceAll("\n", "\\n")
    }
}

function isInsideAnyRange(span: SourceSpan, ranges: SourceSpan[]): boolean {
    return ranges.some((range) => {
        return span.pos >= range.pos && span.end <= range.end
    })
}

function formatNodeLine(node: ts.Node, sourceFile: ts.SourceFile): string {
    const span = sourceSpan(node, sourceFile)

    if (span === undefined) {
        return `${ts.SyntaxKind[node.kind]} ${nodeLabel(node)} synthetic`
    }

    return `${ts.SyntaxKind[node.kind]} ${nodeLabel(node)} ${formatRange(sourceFile, span)}`
}

function formatRange(sourceFile: ts.SourceFile, span: SourceSpan): string {
    const start  = sourceFile.getLineAndCharacterOfPosition(span.start)
    const finish = sourceFile.getLineAndCharacterOfPosition(span.finish)

    return [
        `pos/end ${span.pos}/${span.end}`,
        `start ${span.start} (${start.line + 1}:${start.character + 1})`,
        `end ${span.finish} (${finish.line + 1}:${finish.character + 1})`,
        JSON.stringify(span.text)
    ].join(" ")
}

function nodeLabel(node: ts.Node): string {
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        return node.text
    }

    const name = "name" in node ? node.name : undefined

    if (isNode(name) && ts.isIdentifier(name)) {
        return name.text
    }

    if ("text" in node && typeof node.text === "string") {
        return node.text
    }

    return "<none>"
}

function isNode(value: unknown): value is ts.Node {
    return typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        typeof value.kind === "number"
}
