# tsserver source-view invariants

The IDE "source view" (mode `"ide"` / tsserver: unprinted, position-preserving transform in `src/index.ts`) has non-obvious invariants. Violating any of them produces confusing tsserver errors or crashes:

1. **Never share a node between two declarations.** The binder rebinds `node.parent` to the last visitor, and the checker's `isTypeParameterSymbolDeclaredInContainer` requires `parent === container` — a shared type parameter node makes resolution fail with "Cannot find name 'T'" (TS2304). Note that `factory.cloneNode` is **shallow** (children are shared with the original!) — use `deepCloneNode` (wraps the internal `ts.getSynthesizedDeepClone`) and give each generated declaration its own clones.

2. **Zero-width ranges (`pos === end`) make a node "missing"** for the checker (`nodeIsMissing`): type annotations silently become `any`, identifiers display as `(Missing)`. Generated nodes need width >= 1 — this is why `generatedTextRange` returns `[pos, pos + 1]`.

3. **Overload adjacency is positional.** The checker requires `subsequentNode.pos === node.end` between an overload signature and the next declaration, otherwise it reports TS2391 "Function implementation is missing...". Generated overload members (the `static new` triple) get *consecutive* width-1 ranges — see `overloadRange` in `createConstructionMembers`.

4. **NodeArrays need explicit ranges too.** tsserver services (`getChildren` / `createSyntaxList`) read `nodes.pos` directly and assert `pos >= 0` (`resetTokenState` Debug Failure). `preserveSyntheticDescendantRanges` fixes synthetic arrays via the `cbNodes` callback of `forEachChild`. **Concrete trap:** any *fresh* `factory.createNodeArray([...])` (and `factory.updateClassDeclaration(..., factory.createNodeArray([ ...members, ...generated ]))`) starts with `pos === end === -1`; the original array's range is **not** inherited. You must re-stamp it, e.g. `preserveTextRange(ts, factory.createNodeArray([ ...members, ...generated ]), originalMembers)` — see `expandConsumerClass` and `expandConstructionBaseClass`. A `-1` members array does **not** surface as the `resetTokenState pos>=0` failure — it surfaces as the invariant #5 message ("Did not expect ClassDeclaration to have an Identifier in its trivia"), so don't let that message send you hunting for a heritage gap when the real cause is an unstamped array.

5. **Gaps between sibling children (in array order) must not expose identifier text.** Services scan the tokens in gaps between children and `Debug.fail("Did not expect ... to have an Identifier in its trivia")`. Anchor generated heritage at `heritageClauses?.pos ?? typeParameters?.end ?? name.end` and give heritage NodeArrays tight ranges. Sibling range *overlap* is tolerated; gaps over identifiers are not.

6. **Generated declarations need `setOriginalNode` on the name node, not just on the declaration.** When you emit a sibling declaration that reuses an original class's source range (e.g. `__User$base`), the checker must be able to map its **name identifier** back to a real symbol. Without `tsInstance.setOriginalNode(node.name, original.name)` the name resolves to `undefined`, and any feature that asks for the type at that position (quickinfo, `getTypeAtLocation`) crashes deep in the checker: `tryGetDeclaredTypeOfSymbol → getDeclaredTypeOfSymbol → getTypeOfNode` with `Cannot read properties of undefined (reading 'flags')`. `preserveSourceViewGeneratedClassLikeRange` sets the original node on both the declaration and its `name`. The declaration's range and the name's range are *different* concepts — keep them separate (declaration spans `pos..members.pos`, the name spans `pos..name.end`); collapsing them into one shared range object is a latent bug.

8. **A generated `$base` declaration must not span the original's leading decorator or stranded source identifiers.** `preserveSourceViewGeneratedClassLikeRange` reuses the original class's range for the generated `$base` interface/class, but the generated node has **no decorator** and its first child is the name. For a `@mixin` class, `original.pos` reaches back over the `@mixin()` decorator, so the decorator's `mixin` identifier lands in the generated node's leading trivia gap → invariant #5 crash on the **mixin name** (quickinfo/rename). The `$base` helpers are never navigated to, so when `getDecorators(original)?.length` we collapse the whole subtree to a fully-synthetic `{ pos: -1, end: -1 }` (then `preserveTopLevelStatementRanges` normalises it like the generated helper import); a *positive* zero-width collapse instead overlaps the real declaration at that position and breaks `super.member` quickinfo/rename. Separately, the generated **type parameters** must span the source `<...>` (`{ pos: original.typeParameters.pos, end: original.typeParameters.end }`), not a zero-width range *past* them — a zero-width range leaves each source type-parameter name (the `A` in `Consumer<A>`) stranded in the gap between the generated name and the type-parameter list. **Reproduce these in-process** by transforming with `{ sourceView: true }` (or a `noEmit` program — emit mode places `$base` at generated EOF ranges and hides the bug) and walking the tree **via `node.getChildren(sf)`** (not `forEachChild` — the crash fires inside reconstructed `SyntaxList` nodes that `forEachChild` never yields), catching the trivia `Debug.fail`. Note `consumerHeritageClauses` base type-arguments still have a stranded-identifier facet of this same bug — a generated `__X$base<T, A>` arg can carry a too-wide source range.

7. **The transform must never throw on transient incomplete syntax.** tsserver re-parses **incrementally** on every keystroke, so the transform runs over half-typed code: `class X extends ` while typing `extends` parses the body `{` as an *object-literal base* (`class X extends { … }` with no body), and the incrementally-reused malformed node has an undeterminable parse-tree source file. If the ProgramTransformer **throws** (here: `deepCloneNode`/`getSynthesizedDeepClone` → "Could not determine parsed source file", or `expressionToEntityName` → "Unsupported base class expression"), ts-patch's `createProgram` throws, tsserver falls back to the **untransformed** program for the *whole project*, so unrelated construction-base classes lose their generated `static new` — and because the next edits reuse the program structure (`structureIsReused: Completely`), the broken state **sticks until a server restart**, even after the syntax is fixed/reverted. Defenses: `requiredBaseType` returns `undefined` for any base that is not a plain entity name (`isSupportedBaseExpression`), so a malformed/unsupported `extends` degrades to "no base"; `deepCloneNode` falls back to a trivia-preserving clone when the source-file-resolving path throws. Any new code path that clones or name-references an original heritage/type node must tolerate malformed input the same way.

## Construction `new` invariants

The generated construction `new` (the static factory that makes `Mixin.new(...)` / `Consumer.new(...)` return the right instance type) has its own non-obvious rules:

1. **The two transform paths emit *different shapes* and both must be handled.** Emit mode turns a `@mixin` class into a **value-cast** (`const X = ... as unknown as <type>`) — there is no class body, so the construction `new` is a member *prepended to the cast type*. Source view keeps a **real class**, so the construction `new` is generated as `static new` *class members*. A fix that touches only one path silently leaves the other broken — and because `resolveUsePrintedSourceFile` picks emit for `!noEmit` builds and source-view for `noEmit`/tsserver, you get the trap where `tsc` passes while `tsc --noEmit` and the IDE fail. Always verify a construction change with **both** `tsc` (emit) and `tsc --noEmit` (source-view).

2. **In a type literal, `new(...): T` is a construct signature, not a property named `new`.** To put a callable `.new` on a value-cast type you must use a **property signature** `new: (props?) => Instance` (`factory.createPropertySignature` + a function type), *not* `factory.createMethodSignature("new", ...)` — the latter prints as `new (...) => T` and provides no `.new` member (symptom: TS2339 "Property 'new' does not exist"). A method literally named `new` is only expressible in a **class** (`static new`), which is why the source-view path can use a method but the emit value cast cannot. `declare` does not rescue the value cast: it is not a type-literal concept at all, and in a class it is allowed only on **property/field** members, not methods (`declare static new(...)` → TS1031; only `declare static new: (...) => T` is legal) — and that property form reintroduces the strict-param variance of #3. So the source-view `static new` is a real method, which in a concrete class must have an implementation body (or overload + impl, → TS2391 otherwise); there is no bodiless shortcut that keeps method (bivariant) semantics.

3. **Property-typed `new` is checked contravariantly (strict); a class `static new` is bivariant.** A consumer generates its own `static new` (returning the consumer type, often with *more* required config than the mixins it applies). If it also *inherited* a mixin's value-cast `new` (a property → strict params), the consumer's stricter `new` would be an incompatible static-side override → TS2417 "Class static side ... incorrectly extends". Therefore a consumer **excludes `"new"` from every applied mixin's inherited statics**: `Omit<typeof Mixin, "prototype" | "new">` (see `createMixinStaticsType`), not `ClassStatics<typeof Mixin>`. The consumer's own `new` is the only one that should win.

4. **Config-field optionality comes from the `?` token, not the initializer.** `public x: T = v` is a **required** config field (`new(props: Pick<…, "x">)`); only `public x?: T` is optional (`new(props?: Partial<…>)`). An initializer alone does not make a config field optional. Only `public` members enter the config at all.

## Symptom → cause

The same crash text has several possible causes; check them in this order before assuming the obvious one:

| tsserver / checker message | likely cause |
| --- | --- |
| `Did not expect ... to have an Identifier in its trivia` | a NodeArray with `pos/end === -1` (invariant #4 trap) **or** a real gap over an identifier between siblings (#5). Check `members.pos/end` first. |
| `Debug Failure ... resetTokenState` / `pos >= 0` | a synthetic NodeArray that was never range-stamped (#4). |
| `Cannot read properties of undefined (reading 'flags')` in `tryGetDeclaredTypeOfSymbol` | a generated declaration whose `name` node has no original node / no resolvable symbol (#6). |
| `Cannot find name 'T'` (TS2304) on a type parameter | a node shared between two declarations; `cloneNode` is shallow (#1). |
| type annotation silently `any`, identifier shows `(Missing)` | a zero-width range (#2). |
| TS2391 "Function implementation is missing" on the `static new` triple | non-consecutive overload ranges (#3). |
| TS2339 "Property 'new' does not exist" on a mixin value | the value-cast `new` was built with a method signature (→ construct signature) instead of a property signature (construction `new` #2). |
| TS2417 "Class static side ... incorrectly extends" on a consumer | the consumer inherited an applied mixin's value-cast `new` instead of omitting it (construction `new` #3). |
| construction bug reproduces under `--noEmit`/IDE but not under `tsc` (or vice-versa) | the fix touched only one of the emit / source-view paths (construction `new` #1). |
| `Could not determine parsed source file` / `Unsupported base class expression`, only in tsserver while typing | the transform threw on a transient incomplete-syntax node from incremental parsing (source-view #7). |
| a diagnostic (e.g. `Unused '@ts-expect-error'`) appears on **unrelated** code after an edit and persists until server restart | the ProgramTransformer threw mid-edit, so tsserver is serving the untransformed fallback program for the whole project (source-view #7). |

## Debugging scripts (`scripts/`)

Before writing a throwaway debug script, use the reusable ones in `scripts/` (compiled by `pnpm build` to `dist/scripts/`, full usage in `scripts/README.md`). They cover the recurring tasks: print transformed code, print the source-view AST with ranges, run a whole program and read its diagnostics / resolved types. Input is `--file <path>` / positional path / `--code "<snippet>"` / stdin; a snippet must import `mixin`/`Base` from the package to be transformed. `--mode emit|ide|both` selects the printed (emit) vs position-preserving source-view (ide) pass.

- `node dist/scripts/print-transformed.js [--mode emit|ide|both]` — emitted code for a single file/snippet.
- `node dist/scripts/print-ast.js [--mode ide|emit]` — AST tree with `[pos,end]`, flagging `⚠ NEGATIVE` / `⚠ ZERO-WIDTH` ranges and each class/interface `<members[]>` range (the range bugs behind invariants #2/#4/#5).
- `node dist/scripts/program-diagnostics.js [--file <substr>] [--mode emit|ide] [--print] [--types <prop>]` — real cross-file ProgramTransformer over a tsconfig (default fixture-suite), printing semantic diagnostics and, with `--types new`, the resolved type/return of every `.new` access. This is the only one that exercises the cross-file registry; prefer it for "what does the IDE see" questions (`--mode ide`).

If you do need a one-off, the lower-level reproduction trick below still applies.

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

**This trick only reproduces *checker* diagnostics (`getSemanticDiagnostics`).** The invariant #4/#5/#6 crashes above fire in tsserver *services* — `getTokenAtPosition` / `getChildren` / `createSyntaxList` / quickinfo — which the plain program API never exercises. To hit those you need either a real tsserver session (the `tsserver-*.t.ts` tests drive one) or `LanguageService.getQuickInfoAtPosition` over a fixture. The cheapest reproduction for a single fixture is a real cross-file build: write the files to a temp dir with the plugin tsconfig and run the patched `node node_modules/typescript/bin/tsc -p …` (this is exactly what `createTypeScriptFixture` + the `*-build-and-runtime.t.ts` tests do — prefer adding a fixture test over a throwaway script).

**Inspect generated ranges without tsserver.** Most of these failures are a wrong `pos`/`end` somewhere. Call the transform directly in source-view mode and walk the result, printing ranges — this is how you catch a `-1` array, a zero-width node, or an overlapping gap before it ever reaches a service:

```js
const { transformSourceFile } = await import("./dist/src/index.js")
const sf  = ts.createSourceFile("source.ts", text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
const out = transformSourceFile(ts, sf, { sourceView: true, packageName: "ts-mixin-class" })
for (const st of out.statements) {
    if (!ts.isClassDeclaration(st)) continue
    console.log(st.name?.escapedText, `[${st.pos},${st.end}]`, "members", st.members.pos, st.members.end)
    st.members.forEach(m => console.log("   ", m.name?.escapedText ?? ts.SyntaxKind[m.kind], `[${m.pos},${m.end}]`))
}
```

Note `transformSourceFile` is single-file: it has no registry, so cross-file resolution (imported mixins, cross-file construction bases) is *not* exercised here — for those, drive a real multi-file program/build.
