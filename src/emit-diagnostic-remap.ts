import type * as ts from "typescript"

import { generatedStaticNewMarker } from "./construction-config.js"
import { rewriteGeneratedNameDiagnostics } from "./diagnostic-name-rewrite.js"
import {
    composeEmittedSourceMap,
    precedingMappingIndex,
    sortedMappingsOf,
    type EmittedFileRemap
} from "./emit-source-map.js"
import type { CrossFileContext, NativeMixinDiagnostic, TransformOptions } from "./model.js"
import type { PrintedSourceMapping, TypeScript } from "./util.js"

// Emit-path diagnostic remapping.
//
// On the emit path the transform reprints the value-cast tree to text and reparses
// it (required: only that form emits correct runtime JS). Mixin expansion adds and
// removes lines, so diagnostics the checker computes over the reprinted text land on
// regenerated lines that do not exist on disk — `tsc` then reports errors at the
// wrong line (a deal-breaker for CI). We keep the reprinted tree for emit, but stash
// the printer's source map on each reprinted file and wrap the program's diagnostic
// getters to translate every diagnostic position back to the real source. The
// language-service / `--noEmit` path is position-preserving already and never reaches
// this code.

// The remap is the same object shape the source-map composition reads (the two are the
// twin consumers of the printer's `printed -> original` mappings) — one type, one lazy
// `sortedMappings` cache, aliased here under the diagnostic-side name.
type DiagnosticRemap = EmittedFileRemap

const diagnosticRemapKey = "__tsMixinClassDiagnosticRemap"

export function attachDiagnosticRemap(
    printedSourceFile: ts.SourceFile,
    originalSourceFile: ts.SourceFile,
    mappings: PrintedSourceMapping[]
): void {
    ;(printedSourceFile as { [diagnosticRemapKey]?: DiagnosticRemap })[diagnosticRemapKey] = {
        originalSourceFile,
        mappings
    }
}

function diagnosticRemapOf(file: ts.SourceFile | undefined): DiagnosticRemap | undefined {
    if (file === undefined) {
        return undefined
    }

    return (file as { [diagnosticRemapKey]?: DiagnosticRemap })[diagnosticRemapKey]
}

// Translate an offset in the reprinted text to the matching offset in the original
// source, via the printer's source map. Returns undefined only when the file carries
// no usable mapping (nothing to anchor to).
function mapPrintedOffsetToSource(
    tsInstance: TypeScript,
    remap: DiagnosticRemap,
    printedSourceFile: ts.SourceFile,
    printedOffset: number
): number | undefined {
    const generated      = tsInstance.getLineAndCharacterOfPosition(printedSourceFile, printedOffset)
    const sortedMappings = sortedMappingsOf(remap)
    const matchIndex     = precedingMappingIndex(sortedMappings, generated.line, generated.character)

    if (matchIndex < 0) {
        return undefined
    }

    const match      = sortedMappings[matchIndex]
    const lineStarts = remap.originalSourceFile.getLineStarts()

    if (match.sourceLine >= lineStarts.length) {
        return undefined
    }

    const lineStart     = lineStarts[match.sourceLine]
    const nextLineStart = match.sourceLine + 1 < lineStarts.length
        ? lineStarts[match.sourceLine + 1]
        : remap.originalSourceFile.text.length

    // On the same generated line, advance from the matched entry's source column by the
    // generated-column delta — but a *generated* run (e.g. a long error-alias) can
    // collapse many printed columns onto one source column, so the next entry on the
    // same generated+source line caps how far the column may advance. Off the matched
    // generated line (preceding-line fallback) keep the entry's own source column.
    let sourceCharacter = match.sourceCharacter

    if (match.generatedLine === generated.line) {
        const next   = sortedMappings[matchIndex + 1]
        const capped = next !== undefined &&
            next.generatedLine === generated.line &&
            next.sourceLine === match.sourceLine
            ? next.sourceCharacter
            : Number.POSITIVE_INFINITY

        sourceCharacter = Math.min(match.sourceCharacter + (generated.character - match.generatedCharacter), capped)
    }

    const offset = lineStart + Math.max(0, sourceCharacter)

    // Never let an extrapolated column cross into the next source line.
    return nextLineStart > lineStart ? Math.min(offset, nextLineStart - 1) : offset
}

function remapDiagnostic<Diagnostic extends ts.Diagnostic | ts.DiagnosticRelatedInformation>(
    tsInstance: TypeScript,
    diagnostic: Diagnostic
): Diagnostic {
    const remap = diagnosticRemapOf(diagnostic.file)

    if (remap === undefined || diagnostic.file === undefined) {
        return diagnostic
    }

    const printedSourceFile = diagnostic.file
    const start             = diagnostic.start === undefined
        ? undefined
        : mapPrintedOffsetToSource(tsInstance, remap, printedSourceFile, diagnostic.start)

    // The position could not be mapped (generated-only line): keep the diagnostic as
    // is rather than pin it onto the original file at a wrong offset.
    if (diagnostic.start !== undefined && start === undefined) {
        return diagnostic
    }

    let length = diagnostic.length

    if (diagnostic.start !== undefined && diagnostic.length !== undefined && start !== undefined) {
        const end = mapPrintedOffsetToSource(tsInstance, remap, printedSourceFile, diagnostic.start + diagnostic.length)

        if (end !== undefined && end >= start) {
            length = end - start
        }
    }

    const relatedInformation = (diagnostic as ts.Diagnostic).relatedInformation?.map((related) => {
        return remapDiagnostic(tsInstance, related)
    })

    return {
        ...diagnostic,
        file               : remap.originalSourceFile,
        start,
        length,
        relatedInformation : relatedInformation ?? (diagnostic as ts.Diagnostic).relatedInformation
    }
}

function remapDiagnostics<Diagnostic extends ts.Diagnostic>(
    tsInstance: TypeScript,
    diagnostics: readonly Diagnostic[]
): Diagnostic[] {
    return diagnostics.map((diagnostic) => remapDiagnostic(tsInstance, diagnostic))
}

// Append the transformer-authored NATIVE diagnostics (scoped to `sourceFile`, or all when the
// whole program is requested) to the checker's diagnostics for the same scope. Each native
// diagnostic is positioned on the ORIGINAL on-disk source, so its `file` is resolved from the
// pre-transform program — correct for both the emit (reprinted) and source-view trees without
// going through the reprint remap. Built lazily and only when there is something to add.
function appendNativeDiagnostics(
    tsInstance: TypeScript,
    originalProgram: ts.Program,
    nativeDiagnostics: NativeMixinDiagnostic[],
    diagnostics: ts.Diagnostic[],
    sourceFile: ts.SourceFile | undefined
): ts.Diagnostic[] {
    if (nativeDiagnostics.length === 0) {
        return diagnostics
    }

    const scoped = sourceFile === undefined
        ? nativeDiagnostics
        : nativeDiagnostics.filter((native) => native.fileName === sourceFile.fileName)

    if (scoped.length === 0) {
        return diagnostics
    }

    const built = scoped.flatMap((native): ts.DiagnosticWithLocation[] => {
        const file = originalProgram.getSourceFile(native.fileName)

        if (file === undefined) {
            return []
        }

        return [ {
            category    : native.category,
            code        : native.code,
            file,
            start       : native.start,
            length      : native.length,
            messageText : native.messageText
        } ]
    })

    return [ ...diagnostics, ...built ]
}

// Wrap the diagnostic getters tsc reports through so emit-path positions point at the
// real source. `getSyntacticDiagnostics` (DiagnosticWithLocation) stays well-typed
// because the remap keeps a `file`. `emit` carries declaration-emit diagnostics.
export function wrapProgramDiagnostics(
    tsInstance: TypeScript,
    program: ts.Program,
    originalProgram: ts.Program,
    nativeDiagnostics: NativeMixinDiagnostic[],
    crossFile: CrossFileContext | undefined,
    options: TransformOptions,
    compilerHost: ts.CompilerHost
): ts.Program {
    const originalGetSyntactic   = program.getSyntacticDiagnostics.bind(program)
    const originalGetSemantic    = program.getSemanticDiagnostics.bind(program)
    const originalGetDeclaration = program.getDeclarationDiagnostics.bind(program)
    const originalEmit           = program.emit.bind(program)
    const compilerOptions        = program.getCompilerOptions()
    // Source maps the inner emit computes are `generated -> printed` (it compiled the
    // reprinted text); only when the compilation asks for maps at all is the write path
    // intercepted to compose the second leg (`printed -> original`) into every map.
    const composeSourceMaps = compilerOptions.sourceMap === true ||
        compilerOptions.inlineSourceMap === true ||
        compilerOptions.declarationMap === true

    // Checker messages that embed a generated base/factory NAME (or a collapsed-range render)
    // are mapped back to the user's own names after the position remap — see
    // `diagnostic-name-rewrite.ts`. Gated per diagnostic on a cheap artifact-pattern test.
    const rewriteNames = <Diagnostic extends ts.Diagnostic>(diagnostics: Diagnostic[]): Diagnostic[] => {
        return rewriteGeneratedNameDiagnostics(tsInstance, diagnostics, originalProgram, crossFile, options)
    }

    program.getSyntacticDiagnostics   = (sourceFile, cancellationToken) => {
        return remapDiagnostics(tsInstance, originalGetSyntactic(sourceFile, cancellationToken))
    }
    program.getSemanticDiagnostics    = (sourceFile, cancellationToken) => {
        // Author-time NATIVE diagnostics ride here alongside the (position-remapped) checker
        // diagnostics, so they reach both `tsc` and tsserver through the one seam.
        return appendNativeDiagnostics(
            tsInstance,
            originalProgram,
            nativeDiagnostics,
            rewriteNames(remapDiagnostics(tsInstance, originalGetSemantic(sourceFile, cancellationToken))),
            sourceFile
        )
    }
    program.getDeclarationDiagnostics = (sourceFile, cancellationToken) => {
        return rewriteNames(remapDiagnostics(tsInstance, originalGetDeclaration(sourceFile, cancellationToken)))
    }
    program.emit                      = (targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers) => {
        // Strip the redundant generated `static new` factories from JS emit (they only
        // forward to the inherited `Base.new`). A `before` transformer runs after type
        // checking but only affects the JS pipeline — declaration emit keeps the typed
        // `static new`, so the public factory type survives in `.d.ts`. No-op for
        // declaration-only emit.
        const mergedTransformers: ts.CustomTransformers | undefined = emitOnlyDtsFiles === true
            ? customTransformers
            : {
                ...customTransformers,
                before : [
                    ...(customTransformers?.before ?? []),
                    stripGeneratedStaticNew(tsInstance)
                ]
            }
        // The composing write path: rewrite every emitted source map through the reprinted
        // file's remap, then hand the (possibly rewritten) text to the caller's `writeFile`
        // or — when none was given, the plain-`tsc` path — to the host's, which is exactly
        // where the default emit pipeline would have written.
        const sink: ts.WriteFileCallback               = writeFile ??
            ((emittedFileName, text, writeByteOrderMark, onError, sourceFiles, data) => {
                compilerHost.writeFile(emittedFileName, text, writeByteOrderMark, onError, sourceFiles, data)
            })
        const composingWriteFile: ts.WriteFileCallback = (emittedFileName, text, writeByteOrderMark, onError, sourceFiles, data) => {
            sink(
                emittedFileName,
                composeEmittedSourceMap(tsInstance, emittedFileName, text, sourceFiles, diagnosticRemapOf),
                writeByteOrderMark,
                onError,
                sourceFiles,
                data
            )
        }
        const result                                   = originalEmit(
            targetSourceFile,
            composeSourceMaps ? composingWriteFile : writeFile,
            cancellationToken,
            emitOnlyDtsFiles,
            mergedTransformers
        )

        return {
            ...result,
            diagnostics : remapDiagnostics(tsInstance, result.diagnostics)
        }
    }

    return program
}

// A `before` emit transformer that drops the generated, runtime-redundant `static new`
// factory from JS output (it only forwards to the inherited `Base.new`). It hooks the method
// node directly: a `static new` whose body opens with the `void "$tmc$"` marker is removed
// (return `undefined`), and `visitEachChild` rebuilds the members array only for the class
// that actually carried it. Removing just the marked IMPLEMENTATION suffices — its sibling
// typed overload signature has no body and so emits nothing in JS, while declaration emit
// keeps it, preserving the public `static new(props: <Class>Config): <Class>` in `.d.ts`.
//
// The marker is a unique string the reprint bakes into the file text, so a single `indexOf`
// gate skips every file without a generated factory (the vast majority) with NO AST traversal.
function stripGeneratedStaticNew(tsInstance: TypeScript): ts.TransformerFactory<ts.SourceFile> {
    return (context) => {
        // The match is inlined (no per-node helper call): drop a `static new` whose body opens
        // with the `void "$tmc$"` marker statement; otherwise recurse.
        const visit = (node: ts.Node): ts.Node | undefined => {
            if (tsInstance.isMethodDeclaration(node) &&
                tsInstance.isIdentifier(node.name) &&
                node.name.text === "new" &&
                node.body !== undefined &&
                node.body.statements.length > 0
            ) {
                const first = node.body.statements[0]

                if (tsInstance.isExpressionStatement(first) &&
                    tsInstance.isVoidExpression(first.expression) &&
                    tsInstance.isStringLiteral(first.expression.expression) &&
                    first.expression.expression.text === generatedStaticNewMarker
                ) {
                    return undefined
                }
            }

            return tsInstance.visitEachChild(node, visit, context)
        }

        return (sourceFile) => {
            // Fast path: no generated factory anywhere in this file — skip AST traversal.
            if (sourceFile.text.indexOf(generatedStaticNewMarker) === -1) {
                return sourceFile
            }

            return tsInstance.visitNode(sourceFile, visit) as ts.SourceFile
        }
    }
}
