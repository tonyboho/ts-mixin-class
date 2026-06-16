# tsserver source-view invariants

The IDE "source view" (mode `"ide"` / tsserver: unprinted, position-preserving transform in `src/index.ts`) has non-obvious invariants. Violating any of them produces confusing tsserver errors or crashes:

1. **Never share a node between two declarations.** The binder rebinds `node.parent` to the last visitor, and the checker's `isTypeParameterSymbolDeclaredInContainer` requires `parent === container` — a shared type parameter node makes resolution fail with "Cannot find name 'T'" (TS2304). Note that `factory.cloneNode` is **shallow** (children are shared with the original!) — use `deepCloneNode` (wraps the internal `ts.getSynthesizedDeepClone`) and give each generated declaration its own clones.

2. **Zero-width ranges (`pos === end`) make a node "missing"** for the checker (`nodeIsMissing`): type annotations silently become `any`, identifiers display as `(Missing)`. Generated nodes need width >= 1 — this is why `generatedTextRange` returns `[pos, pos + 1]`.

3. **Overload adjacency is positional.** The checker requires `subsequentNode.pos === node.end` between an overload signature and the next declaration, otherwise it reports TS2391 "Function implementation is missing...". Generated overload members (the `static new` triple) get *consecutive* width-1 ranges — see `overloadRange` in `createConstructionMembers`.

4. **NodeArrays need explicit ranges too.** tsserver services (`getChildren` / `createSyntaxList`) read `nodes.pos` directly and assert `pos >= 0` (`resetTokenState` Debug Failure). `preserveSyntheticDescendantRanges` fixes synthetic arrays via the `cbNodes` callback of `forEachChild`.

5. **Gaps between sibling children (in array order) must not expose identifier text.** Services scan the tokens in gaps between children and `Debug.fail("Did not expect ... to have an Identifier in its trivia")`. Anchor generated heritage at `heritageClauses?.pos ?? typeParameters?.end ?? name.end` and give heritage NodeArrays tight ranges. Sibling range *overlap* is tolerated; gaps over identifiers are not.

## Debugging trick

Spoof tsserver detection before importing the ts-patch-patched typescript, then create a program over the fixture suite — the plugin auto-applies in source-view mode (`resolveUsePrintedSourceFile` checks `process.argv`), reproducing the exact tsserver diagnostics in a plain, debuggable Node process:

```js
process.argv.push("/fake/tsserver.js")
const { default: ts } = await import("typescript")

const parsed = ts.getParsedCommandLineOfConfigFile("tests/fixture-suite/tsconfig.json", undefined, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(String(d.messageText)) }
})
const program = ts.createProgram(parsed.fileNames, parsed.options, ts.createCompilerHost(parsed.options))
const sf = program.getSourceFile("tests/fixture-suite/src/<fixture>.t.ts")
for (const d of program.getSemanticDiagnostics(sf)) console.log(d.code, ts.flattenDiagnosticMessageText(d.messageText, " | "))
```

From there you can inspect the transformed AST, binder state (`node.symbol`, `node.locals`, `symbol.members`) and checker resolution directly.

Caveat: `tests/fixture-suite/src/type-errors.ts` is intentionally broken — exclude it when transforming the whole program in emit mode.
