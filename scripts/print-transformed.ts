import ts from "typescript"
import { printSourceFile, transformSourceFile } from "../src/index.js"
import {
    createSourceFile,
    modeFromArgs,
    parseArgs,
    readSourceInput,
    transformOptionsFromArgs,
    type SourceInput
} from "./lib/cli.js"

// Print the transformed code for a single-file snippet, in emit and/or
// source-view (ide) mode.
//
//   node dist/scripts/print-transformed.js --file tests/fixture-suite/src/foo.t.ts
//   node dist/scripts/print-transformed.js --mode ide --code "@mixin() class X extends Base {}"
//   echo '<code>' | node dist/scripts/print-transformed.js --mode emit
//
// Caveat: single-file transform has no cross-file registry, so imported mixins /
// cross-file construction bases are not resolved here. Use program-diagnostics
// for those.

const args  = parseArgs(process.argv.slice(2))
const input = readSourceInput(args)
const mode  = modeFromArgs(args, "both")
const opts  = transformOptionsFromArgs(args)

function show(label: string, sourceView: boolean, source: SourceInput): void {
    const transformed = transformSourceFile(ts, createSourceFile(source), { sourceView, ...opts })

    console.log(`// ===== ${label} =====`)
    console.log(printSourceFile(ts, transformed))
    console.log()
}

if (mode === "emit" || mode === "both") {
    show("emit", false, input)
}

if (mode === "ide" || mode === "both") {
    show("source-view (ide)", true, input)
}
