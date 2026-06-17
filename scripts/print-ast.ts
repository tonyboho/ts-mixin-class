import ts from "typescript"
import { transformSourceFile } from "../src/index.js"
import {
    createSourceFile,
    parseArgs,
    readSourceInput,
    transformOptionsFromArgs
} from "./lib/cli.js"

// Print the transformed AST as an indented tree with each node's `[pos, end]`
// range, flagging the range shapes that break tsserver (see AGENTS.md): negative
// (`-1`) and zero-width ranges, plus the `members` NodeArray range of every
// class/interface (a `-1` members array is the usual "Identifier in trivia"
// cause). Defaults to source-view (ide) mode, where ranges actually matter.
//
//   node dist/scripts/print-ast.js --file tests/fixture-suite/src/foo.t.ts
//   node dist/scripts/print-ast.js --mode emit --code "@mixin() class X {}"

const args        = parseArgs(process.argv.slice(2))
const input       = readSourceInput(args)
const sourceView  = (args.options.get("mode") ?? "ide") !== "emit"
const opts        = transformOptionsFromArgs(args)
const transformed = transformSourceFile(ts, createSourceFile(input), { sourceView, ...opts })

function rangeFlag(range: ts.TextRange): string {
    if (range.pos < 0 || range.end < 0) {
        return "  ⚠ NEGATIVE"
    }

    if (range.pos === range.end) {
        return "  ⚠ ZERO-WIDTH"
    }

    return ""
}

function nodeLabel(node: ts.Node): string {
    const kind = ts.SyntaxKind[node.kind]

    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
        return `${kind} "${node.text}"`
    }

    if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
        return `${kind} ${JSON.stringify(node.text)}`
    }

    return kind
}

function indent(depth: number): string {
    return "  ".repeat(depth)
}

function walk(node: ts.Node, depth: number): void {
    console.log(`${indent(depth)}${nodeLabel(node)} [${node.pos},${node.end}]${rangeFlag(node)}`)

    const members = (node as { members?: ts.NodeArray<ts.Node> }).members

    if (members !== undefined && Array.isArray(members)) {
        console.log(`${indent(depth + 1)}<members[]> [${members.pos},${members.end}]${rangeFlag(members)}`)
    }

    ts.forEachChild(node, (child) => walk(child, depth + 1))
}

console.log(`// ===== ${sourceView ? "source-view (ide)" : "emit"} AST: ${input.fileName} =====`)
transformed.statements.forEach((statement) => walk(statement, 0))
