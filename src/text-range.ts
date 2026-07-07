import type * as ts from "typescript"

import type { TypeScript } from "./util.js"

// Position/range pinning for generated nodes, shared by both planes: preserving real
// statement ranges through the transform, pinning generated declarations onto source
// anchors (never zero-width where the checker reads — `nodeIsMissing` silently drops a
// [pos === end] node), and collapsing generated subtrees off-screen. See AGENTS.md
// "Source-view invariants" for the sharp edges each helper guards.

export function preserveTopLevelStatementRanges(tsInstance: TypeScript, sourceFile: ts.SourceFile): void {
    preserveStatementListRanges(tsInstance, sourceFile, sourceFile.statements, 0)
}

// Assign safe real ranges to the generated statements in ONE statement list — the top-level
// list or a nested function/block body. A synthetic ({-1,-1}) generated sibling is collapsed
// into the gap after the previous real statement (exactly where a top-level generated sibling
// sits), so it never strands an identifier in trivia. Generated mixins / consumers can be nested
// inside a function body or block, so each statement is then recursed for its own nested blocks —
// every block gets gap-placed ranges relative to ITS own start, not the enclosing span.
function preserveStatementListRanges(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    statements: ts.NodeArray<ts.Statement>,
    startPosition: number
): void {
    let previousEnd = startPosition

    for (const statement of statements) {
        const descendantRange = preserveSyntheticDescendantRangesAndGetRealRange(
            tsInstance,
            statement,
            generatedTextRange(sourceFile, previousEnd)
        )

        if (statement.pos < 0 || statement.end < 0) {
            tsInstance.setTextRange(
                statement,
                descendantRange ?? generatedTextRange(sourceFile, previousEnd)
            )
        } else if (descendantRange !== undefined) {
            tsInstance.setTextRange(statement, {
                pos : Math.min(statement.pos, descendantRange.pos),
                end : Math.max(statement.end, descendantRange.end)
            })
        }

        if (statement.end >= 0) {
            previousEnd = statement.end
        }

        // A statement that IS a real block (a bare `{ … }`) owns its own list; otherwise descend
        // to find statement lists nested inside it (a function / method / accessor body, a
        // namespace, a `switch` case clause).
        if ((tsInstance.isBlock(statement) || tsInstance.isModuleBlock(statement)) && statement.pos >= 0) {
            preserveStatementListRanges(tsInstance, sourceFile, statement.statements, statement.pos)
        } else {
            preserveNestedBlockStatementRanges(tsInstance, sourceFile, statement)
        }
    }

    const first = statements[0]
    const last  = statements.at(-1)

    if (first !== undefined && last !== undefined) {
        tsInstance.setTextRange(statements, {
            pos : Math.max(0, first.pos),
            end : Math.max(first.end, last.end)
        })
    }
}

// Find every REAL statement-list block reachable inside `node` (a function/method/accessor body,
// a bare block, a namespace block) and preserve its statements as their own list.
function preserveNestedBlockStatementRanges(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    node: ts.Node
): void {
    tsInstance.forEachChild(node, (child) => {
        if (isRealStatementListOwner(tsInstance, child)) {
            preserveStatementListRanges(tsInstance, sourceFile, child.statements, child.pos)
        } else {
            preserveNestedBlockStatementRanges(tsInstance, sourceFile, child)
        }
    })
}

// A node owning a statement list the transform may splice generated siblings into: a block, a
// namespace body, or a `switch` case / default clause (whose list is NOT a `Block`). "Real"
// means positioned — a synthetic one has no source gaps to place generated ranges into.
function isRealStatementListOwner(
    tsInstance: TypeScript,
    node: ts.Node
): node is ts.Node & { statements: ts.NodeArray<ts.Statement> } {
    return (
        tsInstance.isBlock(node) || tsInstance.isModuleBlock(node) ||
        tsInstance.isCaseClause(node) || tsInstance.isDefaultClause(node)
    ) && node.pos >= 0
}

function preserveSyntheticDescendantRangesAndGetRealRange(
    tsInstance: TypeScript,
    node: ts.Node,
    parentRange: ts.TextRange
): ts.TextRange | undefined {
    // A REAL statement-list owner (block, namespace body, `switch` case clause) owns its contents
    // through `preserveStatementListRanges` (gap placement per its own start). Return its range
    // without touching the statements, so a nested generated sibling is never collapsed onto the
    // enclosing owner's full span.
    if (isRealStatementListOwner(tsInstance, node)) {
        return { pos: node.pos, end: node.end }
    }

    const currentRange = node.pos >= 0 && node.end >= 0
        ? {
            pos : node.pos,
            end : node.end
        }
        : parentRange
    let range: ts.TextRange | undefined
    const mergeRange   = (nextRange: ts.TextRange | undefined): void => {
        if (nextRange === undefined) {
            return
        }

        range = range === undefined
            ? { pos: nextRange.pos, end: nextRange.end }
            : {
                pos : Math.min(range.pos, nextRange.pos),
                end : Math.max(range.end, nextRange.end)
            }
    }

    const visit = (child: ts.Node): void => {
        if (child.pos >= 0 && child.end >= 0) {
            mergeRange(child)
        }

        mergeRange(preserveSyntheticDescendantRangesAndGetRealRange(tsInstance, child, currentRange))
    }

    if (node.pos < 0 || node.end < 0) {
        tsInstance.setTextRange(node, currentRange)
    }

    tsInstance.forEachChild(node, visit, (children) => {
        if (children.pos < 0 || children.end < 0) {
            tsInstance.setTextRange(children, currentRange)
        }

        for (const child of children) {
            visit(child)
        }
    })

    return range
}

export function zeroWidthRange(position: number): ts.TextRange {
    return {
        pos : position,
        end : position
    }
}

export function generatedTextRange(sourceFile: ts.SourceFile, position: number): ts.TextRange {
    if (sourceFile.text.length === 0) {
        return zeroWidthRange(0)
    }

    const pos = generatedTextPosition(sourceFile.text, position)

    return {
        pos,
        end : pos + 1
    }
}

function generatedTextPosition(text: string, position: number): number {
    const initialPosition = Math.min(Math.max(0, position), text.length - 1)

    if (!isLineBreak(text[initialPosition])) {
        return initialPosition
    }

    for (let index = initialPosition - 1; index >= 0; index--) {
        if (!isLineBreak(text[index])) {
            return index
        }
    }

    for (let index = initialPosition + 1; index < text.length; index++) {
        if (!isLineBreak(text[index])) {
            return index
        }
    }

    return initialPosition
}

function isLineBreak(char: string | undefined): boolean {
    return char === "\n" || char === "\r"
}

export function preserveTextRange<Range extends ts.TextRange>(
    tsInstance: TypeScript,
    range: Range,
    original: ts.TextRange
): Range {
    tsInstance.setTextRange(range, original)

    return range
}

export function preserveGeneratedDeclarationRange<Node extends ts.Node>(
    tsInstance: TypeScript,
    node: Node,
    range: ts.TextRange,
    original: ts.Node
): Node {
    tsInstance.setOriginalNode(node, original)
    preserveGeneratedOriginalNodes(tsInstance, node, original)

    return preserveTextRange(tsInstance, node, range)
}

export function preserveSourceViewGeneratedClassLikeRange<
    Node extends ts.ClassDeclaration | ts.InterfaceDeclaration
>(
    tsInstance: TypeScript,
    node: Node,
    original: ts.ClassDeclaration
): Node {
    tsInstance.setOriginalNode(node, original)
    preserveGeneratedOriginalNodes(tsInstance, node, original)

    // The generated `$base` interface and class are internal helpers that never
    // appear in the source and are never navigated to. Earlier this mapped their
    // ranges onto the original class header so they overlapped it — but then a
    // click on the original class *name* (or a generic type parameter) resolved
    // through `getTokenAtPosition` to the overlapping `$base` node instead of the
    // real declaration, so find-all-references / go-to-definition on a consumer
    // class name missed the consumer's own declaration, and quickinfo on a later
    // type parameter landed on the first one. Collapse the whole subtree to an
    // off-screen zero-width range: `.original` is kept (declaration emit and the
    // required-base diagnostics need it, and those diagnostics are positioned from
    // the real consumer, not from these ranges), while every source position stays
    // owned by the real, position-preserved declaration. A decorated `@mixin`
    // original already relied on this for its `@mixin()` trivia; consumers now do
    // too, so neither a decorator nor a `class ` keyword can strand an identifier.
    collapseSubtreeTextRange(tsInstance, node, { pos: -1, end: -1 })

    return node
}

export function preserveSubtreeTextRange(
    tsInstance: TypeScript,
    node: ts.Node,
    range: ts.TextRange
): void {
    preserveTextRange(tsInstance, node, range)

    tsInstance.forEachChild(node, (child) => {
        preserveSubtreeTextRange(tsInstance, child, range)
    })
}

// Like preserveSubtreeTextRange, but also sets every nested NodeArray's range.
// getChildren reconstructs tokens from NodeArray.pos as well as node.pos, so a
// fully collapsed subtree must pin both — otherwise a NodeArray left at a real
// span reopens a trivia gap the scanner walks.
export function collapseSubtreeTextRange(
    tsInstance: TypeScript,
    node: ts.Node,
    range: ts.TextRange
): void {
    preserveTextRange(tsInstance, node, range)

    tsInstance.forEachChild(
        node,
        (child) => {
            collapseSubtreeTextRange(tsInstance, child, range)
        },
        (children) => {
            tsInstance.setTextRange(children, range)

            for (const child of children) {
                collapseSubtreeTextRange(tsInstance, child, range)
            }
        }
    )
}

function preserveGeneratedOriginalNodes(
    tsInstance: TypeScript,
    node: ts.Node,
    original: ts.Node
): void {
    tsInstance.forEachChild(node, (child) => {
        if (tsInstance.getParseTreeNode(child) === undefined) {
            tsInstance.setOriginalNode(child, original)
        }

        preserveGeneratedOriginalNodes(tsInstance, child, original)
    })
}
