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
        const generatedTypeParameterRange = zeroWidthRange(original.typeParameters?.end ?? original.name?.end ?? original.end)

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
        const originalHeritage      = original.heritageClauses
        const originalHeritageTypes = originalHeritage?.flatMap((heritageClause) => [ ...heritageClause.types ]) ?? []
        const originalHeritageRange = originalHeritage === undefined
            ? zeroWidthRange(original.name?.end ?? original.end)
            : { pos: originalHeritage.pos, end: originalHeritage.end }
        let generatedHeritageRange: ts.TextRange | undefined

        preserveTextRange(tsInstance, node.heritageClauses, originalHeritageRange)

        node.heritageClauses.forEach((heritageClause, index) => {
            const originalClause                = originalHeritage?.[Math.min(index, originalHeritage.length - 1)]
            const clauseRange                   = originalClause ?? originalHeritageRange
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
            preserveTextRange(tsInstance, node.heritageClauses, generatedHeritageRange)
        }
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
