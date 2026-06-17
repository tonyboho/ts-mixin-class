import ts from "typescript"

import { positionToLineOffset } from "../tsserver-util.js"
import type { CorpusFile } from "./corpus.js"

// Every identifier occurrence in a corpus file, with the 1-based line/offset the
// language server expects and the exact identifier span — so a quickinfo / rename
// request can be aimed at a real symbol and the response span can be checked to
// land exactly on it.

export type LineOffset = {
    line   : number,
    offset : number
}

export type SymbolSite = {
    fileName : string,
    name     : string,
    // Position to aim the request at (the first character of the identifier).
    query    : LineOffset,
    // The exact identifier span, for "highlight is exactly on the symbol" checks.
    start    : LineOffset,
    end      : LineOffset
}

export function collectIdentifierSites(file: CorpusFile): SymbolSite[] {
    const sourceFile        = ts.createSourceFile(file.fileName, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const sites: SymbolSite[] = []

    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text.length > 0) {
            const start = positionToLineOffset(file.text, node.getStart(sourceFile))
            const end   = positionToLineOffset(file.text, node.getEnd())

            sites.push({
                fileName : file.fileName,
                name     : node.text,
                query    : start,
                start,
                end
            })
        }

        ts.forEachChild(node, visit)
    }

    visit(sourceFile)

    return sites
}

export function sameLineOffset(left: LineOffset, right: LineOffset): boolean {
    return left.line === right.line && left.offset === right.offset
}
