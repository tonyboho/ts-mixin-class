import path from "node:path"
import ts from "typescript"
import transformProgram from "../src/index.js"
import { parseArgs } from "./lib/cli.js"

// Enumerate every "Did not expect <kind> to have an Identifier in its trivia"
// crash site across a whole fixture suite, in one in-process pass — far faster
// and more complete than driving a tsserver per symbol.
//
//   node dist/scripts/find-trivia-crashes.js                 # whole fixture-suite
//   node dist/scripts/find-trivia-crashes.js --file consumer # only matching files
//   node dist/scripts/find-trivia-crashes.js --tsconfig <p>  # a different suite
//
// It runs the real ProgramTransformer in *source-view* mode (the mode tsserver
// uses — forced here with `noEmit`, since emit mode places generated `$base`
// declarations at throwaway EOF ranges and hides the bug) and walks each file the
// way tsserver navigation does: via `node.getChildren()` (NOT `forEachChild`, so
// the reconstructed `SyntaxList` nodes — where the crash actually fires — are
// visited). For each crash it prints the node kind/range and the exact stranded
// gap (the identifier text and offset), which points straight at the generation
// site that mis-ranged a node. See AGENTS.md source-view invariants #5 and #8.

const args       = parseArgs(process.argv.slice(2))
const tsconfig   = path.resolve(args.options.get("tsconfig") ?? "tests/fixture-suite/tsconfig.json")
const fileFilter = args.options.get("file")

const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic : (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    }
})

if (parsed === undefined) {
    throw new Error(`Cannot read tsconfig ${tsconfig}`)
}

const compilerOptions = { ...parsed.options, noEmit: true }
const program         = ts.createProgram(parsed.fileNames, compilerOptions, ts.createCompilerHost(compilerOptions))
const next            = transformProgram(
    program,
    undefined,
    { transform: "ts-mixin-class" } as Parameters<typeof transformProgram>[2],
    { ts } as Parameters<typeof transformProgram>[3]
)

const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard)

// The first identifier the token scanner finds in [pos, end) — the text tsserver
// rejects as "an Identifier in trivia".
function strandedIdentifier(text: string, pos: number, end: number): { text: string, pos: number } | undefined {
    if (pos < 0 || end <= pos) {
        return undefined
    }

    scanner.setText(text, pos, end - pos)

    let token = scanner.scan()

    while (token !== ts.SyntaxKind.EndOfFileToken) {
        if (token === ts.SyntaxKind.Identifier && scanner.getTokenEnd() <= end) {
            return { text: scanner.getTokenText(), pos: scanner.getTokenStart() }
        }

        token = scanner.scan()
    }

    return undefined
}

// Replicate getChildren's gap scan for one node: report the first child gap that
// strands an identifier (between node.pos and the first child, between siblings,
// or after the last child), descending into NodeArrays the same way.
function firstStrandedGap(node: ts.Node, sourceFile: ts.SourceFile): { text: string, pos: number } | undefined {
    const text     = sourceFile.text
    let pos        = node.pos
    let stranded: { text: string, pos: number } | undefined

    const consider = (childPos: number, childEnd: number): void => {
        if (stranded === undefined && childPos >= 0) {
            stranded = strandedIdentifier(text, pos, childPos)
        }

        if (childEnd >= 0) {
            pos = childEnd
        }
    }

    ts.forEachChild(node, (child) => {
        consider(child.pos, child.end)
    }, (children) => {
        consider(children.pos, children.end)
    })

    return stranded ?? strandedIdentifier(text, pos, node.end)
}

let crashes = 0

for (const sourceFile of next.getSourceFiles()) {
    if (sourceFile.isDeclarationFile ||
        sourceFile.fileName.includes("/node_modules/") ||
        (fileFilter !== undefined && !sourceFile.fileName.includes(fileFilter))) {
        continue
    }

    const visit = (node: ts.Node): void => {
        if (node.pos < 0 || node.end < 0) {
            return
        }

        try {
            node.getChildren(sourceFile)
        } catch (error) {
            if (!/Identifier in its trivia/.test((error as Error).message)) {
                return
            }

            crashes++

            const gap      = firstStrandedGap(node, sourceFile)
            const location = gap === undefined ? "" : ` strands ${JSON.stringify(gap.text)} @${gap.pos}`

            console.log(
                `${path.relative(process.cwd(), sourceFile.fileName)}: ` +
                `${ts.SyntaxKind[node.kind]} [${node.pos},${node.end}]${location}`
            )

            return
        }

        ts.forEachChild(node, visit)
    }

    sourceFile.statements.forEach(visit)
}

console.log(crashes === 0 ? "// no trivia crashes" : `// ${crashes} trivia crash site(s)`)
