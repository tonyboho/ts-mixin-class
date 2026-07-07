import type * as ts from "typescript"
import { cloneNode, scriptKindFromFileName } from "./util.js"
import type { TypeScript } from "./util.js"

// The SourceFile lifecycle of the source-view plane: re-creating / cloning a user file for
// the position-preserving transform, carrying the host `version` and `impliedNodeFormat`
// the builder/watch and DocumentRegistry pipelines assert on, comparing layered-vs-host AST
// shapes, and aligning generated navigable nodes with the parse tree so tsserver navigation
// never walks `.original` into an unbound clone.

type TypeScriptWithParents = TypeScript & {
    setParentRecursive<Node extends ts.Node>(node: Node, incremental: boolean): Node
}

type SourceFileWithVersion = ts.SourceFile & {
    version? : string
}

// Build `CreateSourceFileOptions` that carry `formatSource`'s `impliedNodeFormat` onto a file the
// transform RE-creates from existing text. Under `moduleResolution` node16/nodenext that field is
// part of the `DocumentRegistry` bucket key, so a recreated file that dropped it would be released
// under a key it was never acquired under and crash tsserver's incremental rebuild with a
// `Debug Failure` in `releaseDocumentWithKey` (see tsserver-incremental-rebuild-crash.t.ts). Use
// this at EVERY `createSourceFile` that reprints/clones a user source file.
export function sourceFileOptionsPreservingFormat(
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
    formatSource: ts.SourceFile
): ts.CreateSourceFileOptions {
    const base: ts.CreateSourceFileOptions = typeof languageVersionOrOptions === "object"
        ? languageVersionOrOptions
        : { languageVersion: languageVersionOrOptions }

    return { ...base, impliedNodeFormat: formatSource.impliedNodeFormat }
}

export function cloneSourceFileForTransform(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions
): ts.SourceFile {
    const cloned = tsInstance.createSourceFile(
        sourceFile.fileName,
        sourceFile.text,
        sourceFileOptionsPreservingFormat(languageVersionOrOptions, sourceFile),
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

// The builder/watch pipeline requires every program source file to carry the host's
// `version` (`Debug Failure. Program intended to be used with Builder should have source
// files with versions set` otherwise — it only surfaces under `tsc --watch` WITH emit,
// the one mode the printed path serves that builds a BuilderProgram). A transform-created
// file must inherit the version of the file it replaces.
export function preserveSourceFileVersion(
    sourceFile: ts.SourceFile,
    originalSourceFile: ts.SourceFile
): ts.SourceFile {
    ;(sourceFile as SourceFileWithVersion).version = (originalSourceFile as SourceFileWithVersion).version

    return sourceFile
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
        const escapes  = original !== undefined && !inTree.has(original)

        // A generated node with a positive range already lives in the bound returned
        // tree; only the `Synthesized` flag makes `getParseTreeNode` walk `.original`
        // — into the unbound clone, or to `undefined` when there is no original — and
        // crash the checker (`getSymbolOfDeclaration(...).members` during a scope walk)
        // or, in declaration emit, `isDeclarationAndNotVisible` reading
        // `getParseTreeNode(node).kind`. Clearing the flag makes it resolve to itself;
        // never clear a node whose `.original` resolves in-tree, where the checker must
        // follow it (invariant #9).
        //
        // Two cases, deliberately narrow:
        //   - NAVIGABLE kinds (class-likes, identifiers, type params/refs, heritage
        //     expressions, constructors) only when their `.original` ESCAPES. These are
        //     navigation targets; a *no-original* synthetic among them is the rewritten
        //     heritage (`extends __X$base` pinned onto the source base name), and
        //     clearing its flag breaks find-all-references / rename on the base name.
        //   - GENERATED MEMBERS (the construction `static new` and generated
        //     property/accessor) when they have NO resolvable parse-tree node at all.
        //     They have no source counterpart, are never navigated to, and otherwise
        //     crash declaration-emit diagnostics under `declaration: true`.
        const clearable =
            (escapes && isNavigableGeneratedNodeKind(tsInstance, node)) ||
            ((escapes || original === undefined) && isGeneratedMemberNodeKind(tsInstance, node))

        if (clearable && node.pos >= 0 && node.end >= 0) {
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
        // The construction consumer's `$base` interface re-declares the `Base.initialize`
        // protocol member (to suppress a TS2320 merge conflict between mixins overriding
        // `initialize`). It is real-positioned at `declaration.end` with `.original` (the
        // consumer) escaping into the unbound clone; a `rename`/`definition` on a user
        // `initialize` walks `getParseTreeNode` there and crashes the checker otherwise.
        tsInstance.isMethodSignature(node) ||
        tsInstance.isConstructorDeclaration(node)
}

// Generated class members declaration emit visits via `visitDeclarationSubtree`
// (the construction `static new` and any generated property/accessor). A fully
// synthetic member with no `.original` makes `getParseTreeNode` return `undefined`,
// which crashes `isDeclarationAndNotVisible` under `declaration: true`.
function isGeneratedMemberNodeKind(tsInstance: TypeScript, node: ts.Node): boolean {
    return tsInstance.isMethodDeclaration(node) ||
        tsInstance.isPropertyDeclaration(node) ||
        tsInstance.isGetAccessorDeclaration(node) ||
        tsInstance.isSetAccessorDeclaration(node)
}
