import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

// Shared helpers for the debugging scripts under `scripts/`. These exist so the
// recurring "transform a snippet and look at it" tasks (print emitted code,
// print the source-view AST with ranges, run a whole program and read its
// diagnostics) do not have to be re-written as throwaway scripts each time.

export type ParsedArgs = {
    options : Map<string, string>,
    flags   : Set<string>,
    rest    : string[]
}

// Minimal `--key value` / `--flag` / positional parser. A `--key` followed by a
// token that does not start with `--` is an option; otherwise it is a boolean
// flag.
export function parseArgs(argv: string[]): ParsedArgs {
    const options        = new Map<string, string>()
    const flags          = new Set<string>()
    const rest: string[] = []

    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]

        if (!arg.startsWith("--")) {
            rest.push(arg)

            continue
        }

        const key  = arg.slice(2)
        const next = argv[index + 1]

        if (next !== undefined && !next.startsWith("--")) {
            options.set(key, next)
            index++
        } else {
            flags.add(key)
        }
    }

    return { options, flags, rest }
}

export type SourceInput = {
    fileName : string,
    text     : string
}

// Resolves the snippet to transform from (in order): `--file <path>`, a bare
// positional path, `--code "<snippet>"`, or piped stdin.
export function readSourceInput(args: ParsedArgs): SourceInput {
    const file = args.options.get("file") ?? args.rest[0]

    if (file !== undefined) {
        return { fileName: path.basename(file), text: readFileSync(file, "utf8") }
    }

    const code = args.options.get("code")

    if (code !== undefined) {
        return { fileName: "snippet.ts", text: code }
    }

    const stdin = readFileSync(0, "utf8")

    if (stdin.trim() === "") {
        throw new Error("No input. Pass --file <path>, a file path, --code \"<snippet>\", or pipe code via stdin.")
    }

    return { fileName: "snippet.ts", text: stdin }
}

// A fresh SourceFile per call: the transform must never be handed a node tree it
// has already walked, and several scripts transform the same input twice (emit
// and source-view).
export function createSourceFile(input: SourceInput): ts.SourceFile {
    return ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

export type CommonTransformOptions = {
    packageName?                : string,
    fillMissedInitializersWith? : "undefined" | "null" | "nothing"
}

// Transform options shared by every script: `--package-name <name>` and
// `--fill-missed-initializers <undefined|null|nothing>` (maps to `fillMissedInitializersWith`).
export function transformOptionsFromArgs(args: ParsedArgs): CommonTransformOptions {
    const options: CommonTransformOptions = {}
    const packageName                     = args.options.get("package-name")
    const fill                            = args.options.get("fill-missed-initializers")

    if (packageName !== undefined) {
        options.packageName = packageName
    }

    if (fill === "undefined" || fill === "null" || fill === "nothing") {
        options.fillMissedInitializersWith = fill
    }

    return options
}

// `--mode emit|ide|both` -> which transform passes to show. `ide` is the
// position-preserving source-view pass (what tsserver / the IDE and
// `tsc --noEmit` use); `emit` is the printed pass (what `tsc` emits).
export type TransformMode = "emit" | "ide" | "both"

export function modeFromArgs(args: ParsedArgs, fallback: TransformMode): TransformMode {
    const mode = args.options.get("mode") ?? fallback

    if (mode !== "emit" && mode !== "ide" && mode !== "both") {
        throw new Error(`Unknown --mode ${JSON.stringify(mode)}, expected "emit", "ide", or "both".`)
    }

    return mode
}
