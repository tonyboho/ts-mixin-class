import path from "node:path"
import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import transformProgram from "../src/index.js"
import { packageRoot } from "./util.js"

// Whole-suite guard for the tsserver "Did not expect <kind> to have an Identifier
// in its trivia" crash (source-view invariants #5 / #8): a single in-process pass
// that reproduces what tsserver navigation does — transform every fixture file in
// source-view mode, then walk each node via `getChildren()` (which reconstructs
// the `SyntaxList` nodes where the crash actually fires) — and asserts no node
// strands an identifier in a trivia gap. Far faster and more complete than a
// tsserver-per-symbol test; the `scripts/find-trivia-crashes.js` debug script
// runs the same logic with per-site detail.

const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard)

function strandedIdentifier(text: string, pos: number, end: number): { text: string, pos: number } | undefined {
    if (pos < 0 || end <= pos) {
        return undefined
    }

    scanner.setText(text, pos, end - pos)

    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
        if (token === ts.SyntaxKind.Identifier && scanner.getTokenEnd() <= end) {
            return { text : scanner.getTokenText(), pos : scanner.getTokenStart() }
        }
    }

    return undefined
}

function firstStrandedGap(node: ts.Node, sourceFile: ts.SourceFile): { text: string, pos: number } | undefined {
    const text = sourceFile.text
    let pos    = node.pos
    let stranded: { text: string, pos: number } | undefined

    const consider = (childPos: number, childEnd: number): void => {
        if (stranded === undefined && childPos >= 0) {
            stranded = strandedIdentifier(text, pos, childPos)
        }

        if (childEnd >= 0) {
            pos = childEnd
        }
    }

    ts.forEachChild(node, (child) => consider(child.pos, child.end), (children) => consider(children.pos, children.end))

    return stranded ?? strandedIdentifier(text, pos, node.end)
}

function collectTriviaCrashes(): string[] {
    const tsconfig = path.join(packageRoot, "tests", "fixture-suite", "tsconfig.json")
    const parsed   = ts.getParsedCommandLineOfConfigFile(tsconfig, undefined, {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic : (diagnostic) => {
            throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
        }
    })

    if (parsed === undefined) {
        throw new Error(`Cannot read tsconfig ${tsconfig}`)
    }

    // noEmit forces the position-preserving source-view pass (the mode tsserver
    // uses); emit mode hides the bug behind throwaway generated ranges.
    const compilerOptions = { ...parsed.options, noEmit : true }
    const program         = ts.createProgram(parsed.fileNames, compilerOptions, ts.createCompilerHost(compilerOptions))
    const transformed     = transformProgram(
        program,
        undefined,
        { transform : "ts-mixin-class" } as Parameters<typeof transformProgram>[2],
        { ts } as Parameters<typeof transformProgram>[3]
    )

    const crashes: string[] = []

    for (const sourceFile of transformed.getSourceFiles()) {
        if (sourceFile.isDeclarationFile || sourceFile.fileName.includes("/node_modules/")) {
            continue
        }

        const visit = (node: ts.Node): void => {
            if (node.pos < 0 || node.end < 0) {
                return
            }

            try {
                node.getChildren(sourceFile)
            } catch (error) {
                if (/Identifier in its trivia/.test((error as Error).message)) {
                    const gap = firstStrandedGap(node, sourceFile)

                    crashes.push(
                        `${path.basename(sourceFile.fileName)}: ${ts.SyntaxKind[node.kind]} ` +
                        `[${node.pos},${node.end}]${gap === undefined ? "" : ` strands ${JSON.stringify(gap.text)} @${gap.pos}`}`
                    )
                }

                return
            }

            ts.forEachChild(node, visit)
        }

        sourceFile.statements.forEach(visit)
    }

    return crashes
}

it("source-view transform strands no identifier in any node's trivia (tsserver getChildren)", async (t: Test) => {
    const crashes = collectTriviaCrashes()

    t.equal(crashes.length, 0, `Trivia crash sites:\n  ${crashes.join("\n  ")}`)
})
