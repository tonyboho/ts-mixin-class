import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"

export type TypeScript = ProgramTransformerExtras["ts"]

type TypeScriptWithParents = TypeScript & {
    setParentRecursive<Node extends ts.Node>(node: Node, incremental: boolean): Node
}

type NodeFactoryWithCloneNode = ts.NodeFactory & {
    cloneNode<Node extends ts.Node>(node: Node): Node
}

type SourceFileWithVersion = ts.SourceFile & {
    version? : string
}

export function preserveTopLevelStatementRanges(tsInstance: TypeScript, sourceFile: ts.SourceFile): void {
    let previousEnd = 0

    for (const statement of sourceFile.statements) {
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
    }

    const first = sourceFile.statements[0]
    const last  = sourceFile.statements.at(-1)

    if (first !== undefined && last !== undefined) {
        tsInstance.setTextRange(sourceFile.statements, {
            pos : Math.max(0, first.pos),
            end : Math.max(first.end, last.end)
        })
    }

}

function preserveSyntheticDescendantRangesAndGetRealRange(
    tsInstance: TypeScript,
    node: ts.Node,
    parentRange: ts.TextRange
): ts.TextRange | undefined {
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

export function preserveSyntheticDescendantRanges(
    tsInstance: TypeScript,
    node: ts.Node,
    parentRange: ts.TextRange
): void {
    const currentRange = node.pos >= 0 && node.end >= 0
        ? {
            pos : node.pos,
            end : node.end
        }
        : parentRange

    if (node.pos < 0 || node.end < 0) {
        tsInstance.setTextRange(node, currentRange)
    }

    // NodeArrays need explicit ranges too: tsserver services such as
    // getChildren read nodes.pos directly and fail on negative positions.
    tsInstance.forEachChild(node, (child) => {
        preserveSyntheticDescendantRanges(tsInstance, child, currentRange)
    }, (children) => {
        if (children.pos < 0 || children.end < 0) {
            tsInstance.setTextRange(children, currentRange)
        }

        for (const child of children) {
            preserveSyntheticDescendantRanges(tsInstance, child, currentRange)
        }
    })
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

    // A decorated original (a `@mixin` class) carries its `@mixin()` decorator in
    // leading trivia. This generated `$base` helper has no decorator and its
    // first child is the name, so mapping its range over the original would
    // strand the decorator's `mixin` identifier in the node's trivia gap —
    // tsserver's getChildren / getTokenAtPosition then throws "Did not expect
    // <kind> to have an Identifier in its trivia", crashing quickinfo and rename
    // on the mixin name. These `$base` helpers are never navigated to, so when
    // the original is decorated collapse the whole subtree to a zero-width range
    // at the original start: every trivia gap is then empty, and keeping the
    // position at `original.pos` keeps the inserted statements contiguous so the
    // SourceFile statement list has no identifier-bearing gap either. (Undecorated
    // originals — consumers — keep the rich range mapping below, which their
    // required-base diagnostics depend on; their `class ` prefix is a keyword, not
    // an identifier, so it never trips the trivia check.)
    if (tsInstance.getDecorators(original)?.length) {
        collapseSubtreeTextRange(tsInstance, node, { pos: -1, end: -1 })

        return node
    }

    preserveTextRange(tsInstance, node, {
        pos : original.pos,
        end : original.members.pos
    })

    if (node.name !== undefined && original.name !== undefined) {
        tsInstance.setOriginalNode(node.name, original.name)
        preserveTextRange(tsInstance, node.name, {
            pos : original.name.getStart(original.getSourceFile()),
            end : original.name.end
        })
    }

    if (node.typeParameters !== undefined) {
        // When the original is generic, span the source `<...>` so the source
        // type-parameter identifiers are owned by the generated type parameters.
        // A zero-width range past them instead leaves each source parameter name
        // (e.g. the `A` in `Consumer<A>`) stranded in the gap between the
        // generated name and type-parameter list, and tsserver's getChildren
        // throws "Did not expect <kind> to have an Identifier in its trivia". When
        // the original has no type parameters (the `$base` added synthetic ones
        // such as `__mixinRequiredBase0`), there is no source identifier to strand,
        // so collapse them to a zero-width range after the name.
        const generatedTypeParameterRange = original.typeParameters === undefined
            ? zeroWidthRange(original.name?.end ?? original.end)
            : { pos: original.typeParameters.pos, end: original.typeParameters.end }

        preserveTextRange(tsInstance, node.typeParameters, generatedTypeParameterRange)

        node.typeParameters.forEach((typeParameter) => {
            preserveSubtreeTextRange(
                tsInstance,
                typeParameter,
                generatedTypeParameterRange
            )
        })
    }

    if (node.heritageClauses !== undefined) {
        preserveSourceViewGeneratedHeritageRanges(tsInstance, node.heritageClauses, original)
    }

    if ("members" in node) {
        const generatedHeaderEnd = node.heritageClauses?.end ?? node.typeParameters?.end ?? node.name?.end ?? original.members.pos

        preserveTextRange(tsInstance, node.members, node.members.length === 0
            ? zeroWidthRange(generatedHeaderEnd)
            : original.members
        )

        if (node.members.length === 0) {
            preserveTextRange(tsInstance, node, {
                pos : node.pos,
                end : generatedHeaderEnd
            })
        }
    }

    return node
}

// Map a generated `$base`'s `extends` heritage onto the original's heritage range
// so its cloned base/mixin references line up with the source for navigation and
// required-base diagnostics. A clause that is a pure metadata cast (a
// `ParenthesizedExpression`, not an entity-name reference) is instead pinned to a
// tight synthetic range, since it has no source to map onto.
function preserveSourceViewGeneratedHeritageRanges(
    tsInstance: TypeScript,
    heritageClauses: ts.NodeArray<ts.HeritageClause>,
    original: ts.ClassDeclaration | ts.InterfaceDeclaration
): void {
    const originalHeritage      = original.heritageClauses
    const originalHeritageTypes = originalHeritage?.flatMap((heritageClause) => [ ...heritageClause.types ]) ?? []
    const originalHeritageRange = originalHeritage === undefined
        ? zeroWidthRange(original.name?.end ?? original.end)
        : { pos: originalHeritage.pos, end: originalHeritage.end }
    let generatedHeritageRange: ts.TextRange | undefined

    preserveTextRange(tsInstance, heritageClauses, originalHeritageRange)

    heritageClauses.forEach((heritageClause, index) => {
        const originalClause = originalHeritage?.[Math.min(index, originalHeritage.length - 1)]
        const clauseRange    = originalClause ?? originalHeritageRange

        // A generated `$base` metadata cast (`extends (Object as unknown as ...)`)
        // has a `ParenthesizedExpression`, not an entity name, as its expression.
        // It carries no type arguments, so mapping it onto a source heritage type
        // that does (the implements-only consumer's `SourceClass1<T>`) leaves that
        // type's `<...>` in a SyntaxList trivia gap (invariant #5). The cast is
        // never navigated, so give the whole clause a tight width-1 synthetic range
        // — positive width keeps the cast from being treated as a "missing" type
        // (invariant #2), and a single non-identifier char stranded nothing.
        if (heritageClause.types.some((heritageType) => tsInstance.isParenthesizedExpression(heritageType.expression))) {
            const castRange = generatedTextRange(original.getSourceFile(), clauseRange.pos)

            collapseSubtreeTextRange(tsInstance, heritageClause, castRange)

            generatedHeritageRange = generatedHeritageRange === undefined
                ? castRange
                : {
                    pos : Math.min(generatedHeritageRange.pos, castRange.pos),
                    end : Math.max(generatedHeritageRange.end, castRange.end)
                }

            return
        }

        const mappedOriginalTypes           = heritageClause.types.map((_heritageType, typeIndex) => {
            return originalHeritageTypes[typeIndex] ??
                originalClause?.types[Math.min(typeIndex, originalClause.types.length - 1)]
        })
        const mappedOriginalTypesWithRanges = mappedOriginalTypes.filter((type): type is ts.ExpressionWithTypeArguments => {
            return type !== undefined
        })

        const heritageTypesRange = mappedOriginalTypesWithRanges.length === 0
            ? clauseRange
            : {
                pos : mappedOriginalTypesWithRanges[0].pos,
                end : mappedOriginalTypesWithRanges.at(-1)!.end
            }

        const nextHeritageRange = {
            pos : clauseRange.pos,
            end : heritageTypesRange.end
        }

        generatedHeritageRange = generatedHeritageRange === undefined
            ? nextHeritageRange
            : {
                pos : Math.min(generatedHeritageRange.pos, nextHeritageRange.pos),
                end : Math.max(generatedHeritageRange.end, nextHeritageRange.end)
            }

        preserveTextRange(tsInstance, heritageClause, nextHeritageRange)
        preserveTextRange(tsInstance, heritageClause.types, heritageTypesRange)

        heritageClause.types.forEach((heritageType, typeIndex) => {
            const originalType = mappedOriginalTypes[typeIndex]
            const typeRange    = originalType ?? clauseRange

            preserveTextRange(tsInstance, heritageType, typeRange)
            preserveTextRange(tsInstance, heritageType.expression, originalType?.expression ?? typeRange)

            if (heritageType.typeArguments !== undefined) {
                const originalTypeArguments      = originalType?.typeArguments
                const generatedTypeArgumentRange = zeroWidthRange(heritageType.expression.end)

                preserveTextRange(
                    tsInstance,
                    heritageType.typeArguments,
                    originalTypeArguments ?? generatedTypeArgumentRange
                )

                heritageType.typeArguments.forEach((typeArgument, argumentIndex) => {
                    preserveSubtreeTextRange(
                        tsInstance,
                        typeArgument,
                        originalTypeArguments?.[argumentIndex] ?? generatedTypeArgumentRange
                    )
                })
            }
        })
    })

    if (generatedHeritageRange !== undefined) {
        preserveTextRange(tsInstance, heritageClauses, generatedHeritageRange)
    }
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

    tsInstance.forEachChild(node, (child) => {
        collapseSubtreeTextRange(tsInstance, child, range)
    }, (children) => {
        tsInstance.setTextRange(children, range)

        for (const child of children) {
            collapseSubtreeTextRange(tsInstance, child, range)
        }
    })
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

export function cloneSourceFileForTransform(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions
): ts.SourceFile {
    const cloned = tsInstance.createSourceFile(
        sourceFile.fileName,
        sourceFile.text,
        languageVersionOrOptions,
        true,
        scriptKindFromFileName(tsInstance, sourceFile.fileName)
    )

    ;(cloned as SourceFileWithVersion).version = (sourceFile as SourceFileWithVersion).version

    return cloned
}

export function cloneLayeredSourceFileForTransform(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): ts.SourceFile {
    const transformed = tsInstance.transform(sourceFile, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                return cloneNode(tsInstance, tsInstance.visitEachChild(node, visit, context))
            }

            return (nextSourceFile) => tsInstance.visitNode(nextSourceFile, visit) as ts.SourceFile
        }
    ])

    try {
        const cloned = transformed.transformed[0]

        ;(cloned as SourceFileWithVersion).version = (sourceFile as SourceFileWithVersion).version

        return (tsInstance as TypeScriptWithParents).setParentRecursive(cloned, false)
    } finally {
        transformed.dispose()
    }
}

export function hasDifferentAstShape(
    tsInstance: TypeScript,
    left: ts.SourceFile,
    right: ts.SourceFile
): boolean {
    const leftStack: ts.Node[]     = [ left ]
    const rightStack: ts.Node[]    = [ right ]
    const leftChildren: ts.Node[]  = []
    const rightChildren: ts.Node[] = []
    const collectChildren          = (node: ts.Node, children: ts.Node[]): void => {
        children.length = 0

        tsInstance.forEachChild(node, (child) => {
            children.push(child)
        })
    }

    while (leftStack.length > 0) {
        const leftNode  = leftStack.pop() as ts.Node
        const rightNode = rightStack.pop()

        if (rightNode === undefined) {
            return true
        }

        if (leftNode.kind !== rightNode.kind || leftNode.pos !== rightNode.pos || leftNode.end !== rightNode.end) {
            return true
        }

        collectChildren(leftNode, leftChildren)
        collectChildren(rightNode, rightChildren)

        if (leftChildren.length !== rightChildren.length) {
            return true
        }

        for (let index = leftChildren.length - 1; index >= 0; index--) {
            leftStack.push(leftChildren[index])
            rightStack.push(rightChildren[index])
        }
    }

    return rightStack.length !== 0
}

export function setParentRecursivePreservingVersion(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    originalSourceFile: ts.SourceFile
): ts.SourceFile {
    ;(sourceFile as SourceFileWithVersion).version = (originalSourceFile as SourceFileWithVersion).version

    return (tsInstance as TypeScriptWithParents).setParentRecursive(sourceFile, false)
}

// The source-view tree is built from a throwaway clone the program never binds.
// Generated nodes carry `.original` links back into that unbound clone (set by
// `factory.update*`, `deepCloneNode`, and explicit `setOriginalNode`). tsserver
// navigation maps a node to its parse tree via `getParseTreeNode`, and because
// `isParseTreeNode` tests ONLY the `Synthesized` flag (not binding/reachability),
// it walks `.original` into the unbound clone and crashes the checker:
// `getSymbolOfDeclaration(<unbound class>).members` during a scope walk, or
// `getTypeAtLocation(<unbound heritage>)` while collecting base-type symbols for
// rename.
//
// These generated nodes already carry preserved positive ranges, so the OTHER,
// position-based notion of synthetic (`nodeIsSynthesized`, `pos < 0`) already
// treats them as real. Clearing the `Synthesized` flag simply aligns the
// flag-based view with that reality: `getParseTreeNode` then returns the node
// itself (it is bound and lives in this tree) and never reaches the clone.
// Crucially `.original` is KEPT, so declaration emit (`isDeclarationAndNotVisible`
// reads `getParseTreeNode(node).kind`) and the generated `$base` required-base /
// linearization diagnostics — both of which rely on `.original` — keep working.
// (TS itself clears this flag on generated import declarations; see program.ts.)
//
// Only nodes whose `.original` escapes this bound tree are touched, and only the
// kinds tsserver navigation resolves through.
export function alignGeneratedNavigableNodesWithParseTree(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): ts.SourceFile {
    const synthesized = tsInstance.NodeFlags.Synthesized
    const inTree      = new Set<ts.Node>()

    const collect = (node: ts.Node): void => {
        inTree.add(node)
        tsInstance.forEachChild(node, collect)
    }

    collect(sourceFile)

    const align = (node: ts.Node): void => {
        const original = (node as { original?: ts.Node }).original

        if (
            original !== undefined &&
            !inTree.has(original) &&
            node.pos >= 0 &&
            node.end >= 0 &&
            isNavigableGeneratedNodeKind(tsInstance, node)
        ) {
            ;(node as { flags: number }).flags &= ~synthesized
        }

        tsInstance.forEachChild(node, align)
    }

    align(sourceFile)

    return sourceFile
}

function isNavigableGeneratedNodeKind(tsInstance: TypeScript, node: ts.Node): boolean {
    return tsInstance.isClassDeclaration(node) ||
        tsInstance.isClassExpression(node) ||
        tsInstance.isInterfaceDeclaration(node) ||
        tsInstance.isIdentifier(node) ||
        tsInstance.isTypeParameterDeclaration(node) ||
        tsInstance.isTypeReferenceNode(node) ||
        tsInstance.isExpressionWithTypeArguments(node) ||
        tsInstance.isConstructorDeclaration(node)
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

export function printSourceFile(tsInstance: TypeScript, sourceFile: ts.SourceFile): string {
    let printer = printerCache.get(tsInstance)

    if (printer === undefined) {
        printer = tsInstance.createPrinter({ newLine: tsInstance.NewLineKind.LineFeed })
        printerCache.set(tsInstance, printer)
    }

    return printer.printFile(sourceFile)
}

export function scriptKindFromFileName(tsInstance: TypeScript, fileName: string): ts.ScriptKind {
    if (fileName.endsWith(".tsx") || fileName.endsWith(".mtsx") || fileName.endsWith(".ctsx")) {
        return tsInstance.ScriptKind.TSX
    }

    return tsInstance.ScriptKind.TS
}
