import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"

export type TypeScript = ProgramTransformerExtras["ts"]

type NodeFactoryWithCloneNode = ts.NodeFactory & {
    cloneNode<Node extends ts.Node>(node: Node): Node
}

// Internal printer/source-map APIs ts-patch hands us on the full `typescript`
// module. Used only on the emit path to print the value-cast tree while recording
// where each printed token came from in the original source (see
// `printSourceFileWithMappings`), so emit diagnostics can be remapped to real
// source positions.
type SourceMapHost = {
    getCurrentDirectory(): string,
    getCanonicalFileName(fileName: string): string,
    useCaseSensitiveFileNames(): boolean
}
type SourceMapGenerator = {
    toString(): string
}
type EmitTextWriter = {
    getText(): string
}
// The printer's own decoded-mapping shape — the minimal view `printSourceFileWithMappings`
// reads. (The full public decode/encode pair lives in `emit-source-map.ts`.)
type PrinterDecodedMapping = {
    generatedLine      : number,
    generatedCharacter : number,
    sourceIndex?       : number,
    sourceLine?        : number,
    sourceCharacter?   : number
}
type TypeScriptWithEmitInternals = TypeScript & {
    createTextWriter(newLine: string): EmitTextWriter,
    createSourceMapGenerator(
        host: SourceMapHost,
        file: string,
        sourceRoot: string,
        sourcesDirectoryPath: string,
        generatorOptions: { sourceMap: boolean }
    ): SourceMapGenerator,
    decodeMappings(mappings: string): Iterable<PrinterDecodedMapping>
}

type PrinterWithWriteFile = ts.Printer & {
    writeFile(
        sourceFile: ts.SourceFile,
        writer: EmitTextWriter,
        sourceMapGenerator: SourceMapGenerator
    ): void
}

// A single printed-token → source-position correspondence, in line/character
// coordinates (the units the printer's source map speaks).
export type PrintedSourceMapping = {
    generatedLine      : number,
    generatedCharacter : number,
    sourceLine         : number,
    sourceCharacter    : number
}

export function cloneNode<Node extends ts.Node>(tsInstance: TypeScript, node: Node): Node {
    return (tsInstance.factory as NodeFactoryWithCloneNode).cloneNode(node)
}

// Deep clone: factory.cloneNode is shallow and shares children with the original
// node. In source view that breaks parent chains and name resolution in tsserver.
//
// `getSynthesizedDeepClone(node, false)` suppresses the clone's leading/trailing
// trivia, which internally resolves the node's parse-tree source file. During
// incremental re-parsing in tsserver a half-typed construct (e.g. `class X extends {`
// while typing `extends`) yields a malformed node whose source file cannot be
// determined, so that path throws "Could not determine parsed source file". A
// throwing ProgramTransformer crashes the whole program build, and tsserver then
// sticks with the untransformed fallback until restart, so the transform must
// never throw on transient incomplete syntax. `getSynthesizedDeepClone(node, true)`
// keeps trivia and skips the source-file lookup, so it is a safe fallback here.
export function deepCloneNode<Node extends ts.Node>(tsInstance: TypeScript, node: Node): Node {
    const factory = tsInstance as unknown as {
        getSynthesizedDeepClone<T extends ts.Node>(node: T, includeTrivia?: boolean): T
    }

    try {
        return factory.getSynthesizedDeepClone(node, false)
    } catch {
        return factory.getSynthesizedDeepClone(node, true)
    }
}

export function cloneOptionalNode<Node extends ts.Node>(tsInstance: TypeScript, node: Node | undefined): Node | undefined {
    return node === undefined ? undefined : cloneNode(tsInstance, node)
}

// A type parameter re-targeted at a SIGNATURE position (function expression, function /
// constructor type): variance annotations (`in` / `out`) are legal only on a class,
// interface or type alias (TS1274), so they must not be cloned along. The `update` keeps
// the original's source range, so position preservation is unchanged.
export function stripVarianceAnnotations(
    tsInstance: TypeScript,
    typeParameter: ts.TypeParameterDeclaration
): ts.TypeParameterDeclaration {
    const modifiers = typeParameter.modifiers?.filter((modifier) =>
        modifier.kind !== tsInstance.SyntaxKind.InKeyword &&
        modifier.kind !== tsInstance.SyntaxKind.OutKeyword)

    if (modifiers?.length === typeParameter.modifiers?.length) {
        return typeParameter
    }

    return tsInstance.factory.updateTypeParameterDeclaration(
        typeParameter,
        modifiers !== undefined && modifiers.length > 0 ? modifiers : undefined,
        typeParameter.name,
        typeParameter.constraint,
        typeParameter.default
    )
}

export function cloneOptionalNodeArray<Node extends ts.Node>(
    tsInstance: TypeScript,
    nodes: ts.NodeArray<Node> | undefined
): ts.NodeArray<Node> | undefined {
    if (nodes === undefined) {
        return undefined
    }

    return tsInstance.factory.createNodeArray(nodes.map((node) => cloneNode(tsInstance, node)))
}

export function hasModifier(
    tsInstance: TypeScript,
    node: ts.Node,
    kind: ts.SyntaxKind
): boolean {
    return tsInstance.canHaveModifiers(node) &&
        (tsInstance.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)
}

const printerCache = new WeakMap<TypeScript, ts.Printer>()

function getPrinter(tsInstance: TypeScript): ts.Printer {
    let printer = printerCache.get(tsInstance)

    if (printer === undefined) {
        printer = tsInstance.createPrinter({ newLine: tsInstance.NewLineKind.LineFeed })
        printerCache.set(tsInstance, printer)
    }

    return printer
}

export function printSourceFile(tsInstance: TypeScript, sourceFile: ts.SourceFile): string {
    return getPrinter(tsInstance).printFile(sourceFile)
}

// Print the (value-cast) transformed tree like `printSourceFile`, but also capture
// the printer's source map so callers know where each printed token originated in
// the *original* source. Unchanged user statements keep their original nodes, so
// their mappings are exact; generated nodes map to the original members they were
// derived from (or to nothing). The emit path uses this to remap diagnostics
// computed over the reprinted text back to real source positions.
export function printSourceFileWithMappings(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): { text: string, mappings: PrintedSourceMapping[] } {
    const printer            = getPrinter(tsInstance)
    const internals          = tsInstance as TypeScriptWithEmitInternals
    const writer             = internals.createTextWriter("\n")
    const sourceMapGenerator = internals.createSourceMapGenerator(
        {
            getCurrentDirectory       : () => "",
            getCanonicalFileName      : (fileName) => fileName,
            useCaseSensitiveFileNames : () => true
        },
        "source.js",
        "",
        "",
        { sourceMap: true }
    );

    (printer as PrinterWithWriteFile).writeFile(sourceFile, writer, sourceMapGenerator)

    const rawMappings                      = (JSON.parse(sourceMapGenerator.toString()) as { mappings: string }).mappings
    const mappings: PrintedSourceMapping[] = []

    for (const mapping of internals.decodeMappings(rawMappings)) {
        if (mapping.sourceIndex === undefined || mapping.sourceLine === undefined ||
            mapping.sourceCharacter === undefined
        ) {
            continue
        }

        mappings.push({
            generatedLine      : mapping.generatedLine,
            generatedCharacter : mapping.generatedCharacter,
            sourceLine         : mapping.sourceLine,
            sourceCharacter    : mapping.sourceCharacter
        })
    }

    return { text: writer.getText(), mappings }
}

export function scriptKindFromFileName(tsInstance: TypeScript, fileName: string): ts.ScriptKind {
    if (fileName.endsWith(".tsx") || fileName.endsWith(".mtsx") || fileName.endsWith(".ctsx")) {
        return tsInstance.ScriptKind.TSX
    }

    return tsInstance.ScriptKind.TS
}

// ---------------------------------------------------------------------------
// File-name and class-member readers

export function normalizePath(fileName: string): string {
    return fileName.replaceAll("\\", "/")
}

export function isDeclarationFileName(fileName: string): boolean {
    return /\.d\.[cm]?ts$/.test(normalizePath(fileName))
}

export function shouldSkipFileName(fileName: string): boolean {
    const normalizedFileName = normalizePath(fileName)

    return normalizedFileName.includes("/node_modules/") ||
        normalizedFileName.endsWith(".d.ts") ||
        !/\.[cm]?tsx?$/.test(normalizedFileName)
}

export function propertyNameText(tsInstance: TypeScript, name: ts.PropertyName): string | undefined {
    if (tsInstance.isIdentifier(name) || tsInstance.isStringLiteral(name) || tsInstance.isNumericLiteral(name)) {
        return name.text
    }

    return undefined
}

export function isNamedClassElement(
    member: ts.ClassElement
): member is ts.ClassElement & { name: ts.PropertyName } {
    return member.name !== undefined
}
