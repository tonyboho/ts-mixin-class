import type * as ts from "typescript"

import { implementsTypes } from "./heritage.js"
import { consumerBaseSuffix } from "./naming.js"
import type { TypeScript } from "./util.js"

// Diagnostics the checker raises ON a generated `__X$base` interface itself — a member type
// conflict between the mixins it re-extends (TS2320 "cannot simultaneously extend", TS2430
// "incorrectly extends") — carry the interface's NAME as their span. That name owns no honest
// source position: in source view the whole `$base` subtree is collapsed into the one-character
// gap after the statement preceding the consumer (source-view invariant #8), and on the emit
// plane the interface sits on a fully generated line whose remap falls back to the same
// preceding statement. Either way the error lands on whatever happened to precede the class
// (`const x = 15`), and the checker prints the name from the source text at that span (`'5'`).
//
// This seam pass relocates such a diagnostic onto the consumer's own `implements` list (its
// class name when there is none) and names the consumer in the message. It runs BEFORE the
// emit position remap, in the diagnostic file's own coordinates: the printed consumer keeps the
// user's `implements` clause, whose identifiers the remap translates exactly.

type GeneratedBaseEntry = {
    declaration  : ts.InterfaceDeclaration,
    consumerName : string,
    consumer     : ts.ClassDeclaration | undefined,
    // The checker's error-span start for the interface name (`skipTrivia` from `name.pos`).
    nameStart    : number
}

type GeneratedBaseIndex = {
    byNameStart    : Map<number, GeneratedBaseEntry>,
    byConsumerName : Map<string, GeneratedBaseEntry[]>
}

type TypeScriptWithSkipTrivia = TypeScript & {
    skipTrivia(text: string, pos: number): number
}

const indexCache = new WeakMap<ts.SourceFile, GeneratedBaseIndex>()

function consumerNameOfGeneratedBase(name: string): string | undefined {
    return name.startsWith("__") && name.endsWith(consumerBaseSuffix) && name.length > 2 + consumerBaseSuffix.length
        ? name.slice(2, -consumerBaseSuffix.length)
        : undefined
}

// The checker computes a declaration's error span as `skipTrivia(text, name.pos) .. name.end`
// (`getErrorSpanForNode`); the same internal keeps this index byte-exact with it, including a
// collapsed gap that happens to be whitespace.
function errorSpanStart(tsInstance: TypeScript, file: ts.SourceFile, node: ts.Node): number {
    return (tsInstance as TypeScriptWithSkipTrivia).skipTrivia(file.text, node.pos)
}

function generatedBaseIndexOf(tsInstance: TypeScript, file: ts.SourceFile): GeneratedBaseIndex {
    const cached = indexCache.get(file)

    if (cached !== undefined) {
        return cached
    }

    const index: GeneratedBaseIndex = { byNameStart: new Map(), byConsumerName: new Map() }

    const visitList = (statements: readonly ts.Statement[]): void => {
        statements.forEach((statement, position) => {
            if (tsInstance.isInterfaceDeclaration(statement)) {
                const consumerName = consumerNameOfGeneratedBase(statement.name.text)

                if (consumerName !== undefined) {
                    // The generated siblings are spliced right before their consumer, in the
                    // same statement list — on both planes.
                    const consumer                  = statements
                        .slice(position + 1)
                        .find((candidate): candidate is ts.ClassDeclaration => {
                            return tsInstance.isClassDeclaration(candidate) && candidate.name?.text === consumerName
                        })
                    const entry: GeneratedBaseEntry = {
                        declaration : statement,
                        consumerName,
                        consumer,
                        nameStart   : errorSpanStart(tsInstance, file, statement.name)
                    }

                    index.byNameStart.set(entry.nameStart, entry)

                    const entries = index.byConsumerName.get(consumerName)

                    if (entries === undefined) {
                        index.byConsumerName.set(consumerName, [ entry ])
                    } else {
                        entries.push(entry)
                    }
                }
            }

            visitNested(statement)
        })
    }
    const visitNested = (node: ts.Node): void => {
        tsInstance.forEachChild(node, (child) => {
            if (
                tsInstance.isBlock(child) || tsInstance.isModuleBlock(child) ||
                tsInstance.isCaseClause(child) || tsInstance.isDefaultClause(child)
            ) {
                visitList(child.statements)
            } else {
                visitNested(child)
            }
        })
    }

    visitList(file.statements)
    indexCache.set(file, index)

    return index
}

// What the checker PRINTS for the consumer's generated `$base` name in this file: the source
// text at the name's error span. In source view that is the one collapsed gap character
// (`}`, `5`, …); on the emit plane it is the real `__X$base` identifier. `undefined` when the
// file carries no generated base for the class — an original (untransformed) file, for one.
export function generatedBaseNameRender(
    tsInstance: TypeScript,
    file: ts.SourceFile,
    consumerName: string,
    consumerPosition: number | undefined
): string | undefined {
    const entries = generatedBaseIndexOf(tsInstance, file).byConsumerName.get(consumerName)

    if (entries === undefined) {
        return undefined
    }

    // Same-named consumers in sibling scopes each own a generated base; the position-preserving
    // source-view plane lets the consumer's own start pick its entry.
    const entry = entries.find((candidate) => candidate.consumer?.pos === consumerPosition) ?? entries[0]

    return file.text.slice(entry.nameStart, entry.declaration.name.end)
}

export function relocateGeneratedBaseDiagnostics<Diagnostic extends ts.Diagnostic>(
    tsInstance: TypeScript,
    diagnostics: readonly Diagnostic[]
): Diagnostic[] {
    return diagnostics.map((diagnostic) => relocateGeneratedBaseDiagnostic(tsInstance, diagnostic))
}

function relocateGeneratedBaseDiagnostic<Diagnostic extends ts.Diagnostic>(
    tsInstance: TypeScript,
    diagnostic: Diagnostic
): Diagnostic {
    const file = diagnostic.file

    if (file === undefined || diagnostic.start === undefined) {
        return diagnostic
    }

    const entry = generatedBaseIndexOf(tsInstance, file).byNameStart.get(diagnostic.start)

    if (entry === undefined || entry.consumer === undefined) {
        return diagnostic
    }

    const name = entry.declaration.name

    // Exactly the interface name's span, nothing wider: a diagnostic merely STARTING at the
    // collapsed gap but spanning real text belongs to the user's code.
    if (diagnostic.length !== name.end - entry.nameStart) {
        return diagnostic
    }

    const anchor      = relocationAnchor(tsInstance, file, entry.consumer)
    const rendered    = file.text.slice(entry.nameStart, name.end)
    const messageText = renameHeadMessage(diagnostic.messageText, `'${rendered}'`, `'${entry.consumerName}'`)

    return {
        ...diagnostic,
        start  : anchor.start,
        length : anchor.end - anchor.start,
        messageText
    }
}

// The consumer's `implements` list (first to last entry) — the clause the conflicting layers
// were named in; its own class name when the consumer lists no mixin at all.
function relocationAnchor(
    tsInstance: TypeScript,
    file: ts.SourceFile,
    consumer: ts.ClassDeclaration
): { start: number, end: number } {
    const types = implementsTypes(tsInstance, consumer)
    const first = types[0]
    const last  = types.at(-1)

    if (first !== undefined && last !== undefined) {
        return { start: errorSpanStart(tsInstance, file, first), end: last.end }
    }

    const nameNode = consumer.name ?? consumer

    return { start: errorSpanStart(tsInstance, file, nameNode), end: nameNode.end }
}

// The interface's own name is the FIRST quoted name of the head message (`Interface '{0}' …`);
// the chained elaborations name members and the conflicting layers, never the interface.
function renameHeadMessage(
    message: string | ts.DiagnosticMessageChain,
    from: string,
    to: string
): string | ts.DiagnosticMessageChain {
    if (typeof message === "string") {
        return message.replace(from, to)
    }

    const messageText = message.messageText.replace(from, to)

    return messageText === message.messageText ? message : { ...message, messageText }
}
