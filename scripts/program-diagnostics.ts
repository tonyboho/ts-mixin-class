import path from "node:path"
import ts from "typescript"
import transformProgram from "../src/index.js"
import { parseArgs } from "./lib/cli.js"

// Run the real ProgramTransformer over a whole tsconfig (cross-file registry and
// all), then read what the checker sees — the practical stand-in for "what the
// language server reports", without driving a tsserver process.
//
//   node dist/scripts/program-diagnostics.js                      # fixture-suite, ide mode, all files
//   node dist/scripts/program-diagnostics.js --file repro --print # print one transformed file + its diagnostics
//   node dist/scripts/program-diagnostics.js --mode emit          # what `tsc` (emit) checks instead
//   node dist/scripts/program-diagnostics.js --file repro --types new  # resolved type of every `.new` access
//
// `--mode ide` reproduces the IDE / `tsc --noEmit` source-view diagnostics;
// `--mode emit` reproduces the printed `tsc` build. `type-errors.ts` in the
// fixture suite is intentionally broken — filter with `--file` to avoid its noise.

const args       = parseArgs(process.argv.slice(2))
const tsconfig   = path.resolve(args.options.get("tsconfig") ?? "tests/fixture-suite/tsconfig.json")
const fileFilter = args.options.get("file")
const typesProp  = args.options.get("types")
const doPrint    = args.flags.has("print")
const mode       = args.options.get("mode") ?? "ide"

if (mode !== "emit" && mode !== "ide") {
    throw new Error(`Unknown --mode ${JSON.stringify(mode)}, expected "emit" or "ide".`)
}

const parsed = ts.getParsedCommandLineOfConfigFile(tsconfig, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic : (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    }
})

if (parsed === undefined) {
    throw new Error(`Cannot read tsconfig ${tsconfig}`)
}

const program      = ts.createProgram(parsed.fileNames, parsed.options, ts.createCompilerHost(parsed.options))
const plugins      = parsed.options.plugins as ts.PluginImport[] | undefined
const pluginConfig = (plugins?.[0] ?? {}) as Record<string, unknown>
const next         = transformProgram(
    program,
    undefined,
    { ...pluginConfig, transform: "ts-mixin-class", mode } as Parameters<typeof transformProgram>[2],
    { ts } as Parameters<typeof transformProgram>[3]
)
const checker      = next.getTypeChecker()

const targets = next.getSourceFiles().filter((sourceFile) => {
    return !sourceFile.isDeclarationFile &&
        !sourceFile.fileName.includes("/node_modules/") &&
        (fileFilter === undefined || sourceFile.fileName.includes(fileFilter))
})

function location(file: ts.SourceFile, start: number | undefined): string {
    if (start === undefined) {
        return ""
    }

    const { line, character } = file.getLineAndCharacterOfPosition(start)

    return `:${line + 1}:${character + 1}`
}

function reportPropertyTypes(sourceFile: ts.SourceFile, name: string): void {
    function walk(node: ts.Node): void {
        if (ts.isPropertyAccessExpression(node) && node.name.text === name) {
            const accessType = checker.typeToString(checker.getTypeAtLocation(node))
            let returnType   = ""

            if (ts.isCallExpression(node.parent) && node.parent.expression === node) {
                const signature = checker.getResolvedSignature(node.parent)
                returnType      = signature === undefined
                    ? ""
                    : ` -> returns ${checker.typeToString(checker.getReturnTypeOfSignature(signature))}`
            }

            console.log(`//   .${name}${location(sourceFile, node.name.getStart(sourceFile))}: ${accessType}${returnType}`)
        }

        ts.forEachChild(node, walk)
    }

    walk(sourceFile)
}

for (const sourceFile of targets) {
    console.log(`// ===== ${path.relative(process.cwd(), sourceFile.fileName)} (${mode}) =====`)

    if (doPrint) {
        console.log(ts.createPrinter().printFile(sourceFile))
    }

    const diagnostics = next.getSemanticDiagnostics(sourceFile)

    if (diagnostics.length === 0) {
        console.log("// no semantic diagnostics")
    }

    for (const diagnostic of diagnostics) {
        const where = diagnostic.file === undefined ? "" : location(diagnostic.file, diagnostic.start)

        console.log(`// TS${diagnostic.code}${where} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`)
    }

    if (typesProp !== undefined) {
        reportPropertyTypes(sourceFile, typesProp)
    }

    console.log()
}
