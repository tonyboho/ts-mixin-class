# ts-mixin-class — internals guide for agents

> **Maintaining this doc — never delete a superseded invariant or approach.** When a change
> supersedes something documented here, do NOT remove it: keep its reasoning, demote it, and mark it
> **superseded (kept for context)**, then note what replaced it and why it no longer applies. The
> *why* of a past approach — and the traps it avoided — keeps its value; a future reader re-deriving it
> would re-hit the same pitfalls. Git history is not a substitute for what is read in-context here.

## Architecture in one screen

`ts-mixin-class` is a **ts-patch `ProgramTransformer`** (`transformProgram: true`) that turns
`@mixin` classes and their consumers into plain TypeScript. A **mixin** is a `@mixin` class;
a **consumer** is a class that applies mixins via `extends` / `implements`. Mixins compose
through runtime factories (`class extends base {…}`); a mixin's own `extends Base` records a
*required consumer base* (a constraint on consumers), **not** a runtime parent.

Stock TypeScript gives one declaration only **one face**, but we need two, so every build runs
**two transform paths**, selected by `resolveUsePrintedSourceFile` (checks `noEmit` /
`process.argv`):

- **Emit** (`mode "emit"`, `tsc`, `!noEmit`): a **value-cast** tree
  (`const X = defineMixinClass(...) as unknown as <type>`) — the only form that emits correct
  runtime JS. It is **reprinted to text and reparsed**, so its diagnostics must be remapped
  back to real source positions.
- **Source view** (`mode "ide"`, `--noEmit` / tsserver): a **position-preserving real-class**
  tree for editor navigation. Types-only; it would emit wrong JS. Built from a throwaway
  `cloneSourceFileForTransform` clone — **only the returned file is bound by the program**.
  Generated `$base` interface/class siblings carry the merged heritage + statics and are
  collapsed **off-screen**.

Most invariants below exist because tsserver **crashes** on a synthetic AST whose ranges do
not perfectly cover the source. A change that touches only one path silently breaks the other
(`tsc` passes while `tsc --noEmit` / the IDE fails); verify both.

Debugging scripts and reproduction tricks are at the end — reach for them before writing a
throwaway script.

## Precomputed C3 linearization (merge-plan replay)

A mixin's/consumer's method-resolution order is its **C3 linearization** of the dependency
DAG (`mergeC3Linearizations` in `c3-linearization.ts`). The runtime used to re-run that merge
on every `defineMixinClass(...)` (a mixin's own deps) and every `mixinChain(base, …)` (a
consumer's chain). **Approach B** moves the merge to compile time: the transformer runs C3 and
emits a **merge plan** — a list of `[source, offset, length]` slices over the merge inputs
(`deriveLinearizationPlan` in `linearization.ts`) — and the runtime **replays** it
(`defineMixinClass`'s trailing plan arg, `mixinChainLinearized`) by copying those slices out of
the dependencies' already-materialized linearizations, with **no** good-head search.

- **The inputs ride in scope.** For deps `[d1..dk]` the merge inputs are
  `[ L[d1], …, L[dk], [d1..dk] ]`; all are already values in the file, so the plan is pure
  integers — **no transitive imports**, so it is cross-package safe (`runtime.ts`
  `requirementMergeSources`).
- **Load-bearing invariant.** Plan offsets index into `L[d_i]`, whose order is deterministic
  from the DAG via the same C3. The compiler reconstructs that order in key space; the runtime
  array (built by the dep's own plan) is identical — so integer offsets line up **without any
  value identity crossing the package boundary**. Validated single-module / cross-file /
  cross-package by the `*-diamond-linearization.t.ts` compile-and-run tests.
- **C3 stays the fallback** for cases with no plan: dependency-free mixins, manual `.mix` /
  `mixinChain`, a conflicting set (no plan exists), and the `"c3"` mode below.
- **Mode is compile-time, baked into the emit.** The plan is ALWAYS emitted; a trailing magic
  string — `LinearizationMode` = `"verify" | "replay" | "c3"` (`runtime.ts`) — on
  `defineMixinClass` / `mixinChainLinearized` tells the runtime what to do. The COMPILER picks it
  in `resolveTransformOptions` by reading `TS_MIXIN_VERIFY_LINEARIZATION` (default on → `"verify"`,
  set `0` → `"replay"`) and `TS_MIXIN_DISABLE_LINEARIZATION_PLAN` (set `1` → `"c3"`) from the build
  environment (the transformer runs under `tsc` in Node). **The shipped runtime never reads any
  environment — it stays cross-platform.** `"verify"` replays then cross-checks against C3 and
  throws on mismatch; because it's the default, the whole suite + corpus exercise replay==C3 for
  free. Helper: `linearizationMode(options)` in `linearization.ts`. Both options are in the
  transform cache key.
- Bench: `bench/c3/` (`pnpm bench:c3`) — ~26× at 1024 nodes; theory in `bench/c3/README.md`.
- **Compile-time merges are cached at BOTH levels** in `context.linearizationCache`
  (program-wide via `CrossFileContext`, file-local otherwise): per-KEY linearizations under
  the registry key, and the top-level merge of a dependency-key LIST under a NUL-joined key
  (`mergedDependencyLinearization` in `linearization.ts` — NUL can never collide with a
  registry key `<path>::<name>`). The same list is merged several times per class (conflict
  check → plan / source-view chain → override diagnostics), so this halves-to-thirds the
  transform's C3 cost (~-20% whole-pass on the large bench rows). A conflicting list stays
  uncached: it must keep throwing on every call. Callers never mutate the cached array —
  `linearizeDependencies` maps it into fresh refs.

## Source-view invariants

Violating any of these produces confusing tsserver errors or crashes.

1. **Never share a node between two declarations.** The binder rebinds `node.parent` to the
   last visitor, and the checker's `isTypeParameterSymbolDeclaredInContainer` requires
   `parent === container` — a shared type-parameter node fails resolution with "Cannot find
   name 'T'" (TS2304). `factory.cloneNode` is **shallow** (children are shared!) — use
   `deepCloneNode` (wraps `ts.getSynthesizedDeepClone`) and give each generated declaration
   its own clones.

2. **Zero-width ranges (`pos === end`) make a node "missing"** (`nodeIsMissing`): type
   annotations silently become `any`, identifiers display as `(Missing)`. Generated nodes need
   width ≥ 1 — `generatedTextRange` returns `[pos, pos + 1]`.

3. **Overload adjacency is positional.** The checker requires `subsequentNode.pos === node.end`
   between an overload signature and the next declaration, else TS2391 "Function implementation
   is missing". The generated `static new` triple gets *consecutive* width-1 ranges — see
   `overloadRange` in `createConstructionMembers`.

4. **NodeArrays need explicit ranges too.** Services (`getChildren` / `createSyntaxList`) read
   `nodes.pos` directly and assert `pos >= 0` (`resetTokenState` Debug Failure).
   `preserveSyntheticDescendantRanges` fixes synthetic arrays via `forEachChild`'s `cbNodes`.
   **Trap:** any *fresh* `factory.createNodeArray([...])` (incl.
   `factory.updateClassDeclaration(..., createNodeArray([...members, ...generated]))`) starts
   at `pos === end === -1`; the original range is **not** inherited — re-stamp it, e.g.
   `preserveTextRange(ts, createNodeArray([...]), originalMembers)`. A `-1` members array
   surfaces **not** as `resetTokenState` but as the invariant #5 message ("Identifier in its
   trivia"), so don't let that message send you hunting for a heritage gap.

5. **Gaps between sibling children (in array order) must not expose identifier text.** Services
   scan tokens in those gaps and `Debug.fail("Did not expect ... to have an Identifier in its
   trivia")`. Anchor generated heritage at `heritageClauses?.pos ?? typeParameters?.end ??
   name.end` and give heritage NodeArrays tight ranges. Sibling range *overlap* is tolerated;
   *gaps* over identifiers are not.

6. **Generated declarations need `setOriginalNode` on the name node, not just the
   declaration.** When a sibling declaration reuses an original class's range (e.g.
   `__User$base`), the checker must map its **name identifier** back to a symbol. Without
   `setOriginalNode(node.name, original.name)` the name resolves to `undefined` and any
   type-at-position feature (quickinfo, `getTypeAtLocation`) crashes in
   `tryGetDeclaredTypeOfSymbol → getTypeOfNode`: `Cannot read properties of undefined (reading
   'flags')`. `preserveSourceViewGeneratedClassLikeRange` sets `.original` on the declaration
   **and** its `name`. That linkage is independent of *range*: the same function collapses the
   whole `$base` subtree off-screen (invariant #8), so the name→symbol mapping comes from
   `.original`, never from a source-overlapping range.

7. **The transform must never throw on transient incomplete syntax.** tsserver re-parses
   **incrementally** on every keystroke, so the transform runs over half-typed code: `class X
   extends ` (while typing) parses the body `{` as an *object-literal base*, and the
   incrementally-reused malformed node has an undeterminable parse-tree source file. If the
   transform **throws** (`deepCloneNode`/`getSynthesizedDeepClone` → "Could not determine
   parsed source file", or `expressionToEntityName` → "Unsupported base class expression"),
   ts-patch's `createProgram` throws, tsserver falls back to the **untransformed** program for
   the *whole project* — unrelated construction-base classes lose their `static new` — and
   because the next edits reuse the program structure (`structureIsReused: Completely`), the
   broken state **sticks until a server restart**, even after the syntax is fixed. Defenses:
   `requiredBaseType` returns `undefined` for any base that is not a plain entity name
   (`isSupportedBaseExpression`), so a malformed `extends` degrades to "no base";
   `deepCloneNode` falls back to a trivia-preserving clone when the source-file-resolving path
   throws. Any new path that clones / name-references an original heritage or type node must
   tolerate malformed input the same way.

8. **A generated `$base` declaration must own no source position — collapse it off-screen.**
   `preserveSourceViewGeneratedClassLikeRange` collapses the *entire* `$base` interface/class
   subtree to `{ pos: -1, end: -1 }` for **every** original — decorated `@mixin` classes and
   undecorated consumers alike (then `preserveTopLevelStatementRanges` normalises the off-screen
   node like the generated helper import). The earlier design reused the original class's range
   for the consumer `$base`, which caused two bugs: (i) for a `@mixin` class, `original.pos`
   reached back over the `@mixin()` decorator, stranding the decorator's `mixin` identifier in
   the generated node's trivia gap → invariant #5 crash; and (ii) for a consumer, the `$base`
   name and type-parameters *overlapped* the real declaration's, so `getTokenAtPosition`
   resolved a click on the consumer **class name** (or a later **type parameter**) to the
   `$base` node — find-all-references / go-to-definition missed the consumer's own declaration,
   and quickinfo on `Consumer<T, A>`'s `A` resolved to `T`. Collapsing fixes both: the `$base`
   is never navigated to, so it needs no position, and `.original` still carries everything
   declaration emit and required-base diagnostics need (those are positioned from the **real**
   consumer — its construction members / validation type arguments — not from the `$base`
   range; collapsing leaves the required-base error byte-identical). Guards:
   `tsserver-references.t.ts` "navigation on a consumer class name reaches its own declaration",
   `tsserver-quickinfo.t.ts` "highlights exactly the consumer's second type parameter", and the
   `stress-references` self-inclusion invariant. **Reproduce range/trivia bugs in-process** by
   transforming with `{ sourceView: true }` (a `noEmit` program) and walking the tree via
   **`node.getChildren(sf)`** (not `forEachChild` — trivia `Debug.fail`s fire inside
   reconstructed `SyntaxList` nodes that `forEachChild` never yields).
   **Other collapse sites (not `$base` class-likes):** (a) **`.mix` apply type — superseded
   (kept for context):** `createSourceViewMixinApplyType` built a pure-typing scaffold from
   `deepCloneNode`d source members carrying their real positions; it was collapsed with
   `collapseSubtreeTextRange(node, {pos:-1, end:-1})` at its generation site. The general
   lessons stand: collapse only works at *statement* granularity
   (`preserveTopLevelStatementRanges` re-expands a `[-1,-1]` node nested in a positioned subtree
   → re-strands), and `[-1,-1]` is *missing* (→ `any`, #2), so a *type* that must still resolve
   needs a **tight positive** width-1 range via `generatedTextRange`. Replaced by the
   program-local manual-`.mix` BAN (TS990012): the node is deleted — a source-view mixin value
   carries no `mix` member at all (the collapsed scaffold could never support navigation:
   go-to-definition landed on the collapsed span; find-all-references on `mix` crashed the
   server resolving entity names against the scopeless `{-1,-1}` node). (b) **Generic construction
   `static new<T>`** (`construction-config.ts`) — the overload `deepCloneNode`s the class type
   parameters (which keep source positions while the method sits at a tiny synthetic range);
   collapse just the cloned type parameters to `{pos:-1, end:-1}` (they normalise into the
   method's range, whose other children cover them — a node's own span over an identifier char
   is fine, only a *gap* between children strands). Do **not** collapse the whole overload or
   shift its anchor: the implementation overload needs factory-fresh children, and a name
   normalised onto whitespace makes `getErrorSpanForNode`'s `skipTrivia` overshoot `end` →
   `Debug.fail` "20809".

9. **A generated *navigable value* declaration must not `setOriginalNode` to a *replaced*
   source declaration — clear the `Synthesized` flag, keep `.original`.** Generated nodes link
   back to their source declarations (`setOriginalNode` / `getSynthesizedDeepClone` /
   `factory.update*`), needed for declaration emit (`getDeclarationDiagnostics`) and the
   name→symbol mapping of #6 — but those links resolve to the **unbound clone**. When tsserver
   maps a *navigated* node to its parse tree (`createDefinitionInfo → symbolToString → 
   getParseTreeNode`) and the original is a declaration the transform **replaced** (lives only
   in the clone), `forEachSymbolTableInScope → getSymbolOfDeclaration(cloneClass)` is
   `undefined` → `Cannot read properties of undefined (reading 'members')`. A *blanket* "clear
   every dangling original" pass is **wrong**: declaration emit and the `$base` required-base /
   linearization diagnostics legitimately need those originals (clearing crashes
   `isDeclarationAndNotVisible`'s unchecked `getParseTreeNode(node).kind` and scrambles
   required-base resolution), and redirecting `.original` in-tree fails because the `update*`
   chain keeps it pointing at the clone. **Resolution:** `getParseTreeNode`'s `isParseTreeNode`
   looks **only** at `NodeFlags.Synthesized`, not at binding/reachability. A generated node with
   a positive range but the flag cleared is returned *as itself* (bound, in the returned tree),
   so the walk never reaches the clone, while `.original` stays intact for emit/diagnostics. The
   nodes already carry positive ranges, so the position-based notion of synthetic
   (`nodeIsSynthesized`, `pos < 0`) already treats them as real; clearing the flag just aligns
   the flag-based view (TS itself does this for generated imports).
   `alignGeneratedNavigableNodesWithParseTree` (post-pass in `getSourceFile` after
   `setParentRecursive`) clears the flag in **two deliberately separate cases**: (a) a generated
   *navigable* node (ClassDeclaration / ClassExpression / InterfaceDeclaration / Identifier /
   TypeParameterDeclaration / TypeReferenceNode / ExpressionWithTypeArguments /
   ConstructorDeclaration) whose `.original` **escapes** the returned tree; and (b) a generated
   *member* (Method / Property / get/set accessor — the construction `static new` and generated
   property/accessor) with **no** resolvable parse-tree node at all. The split is load-bearing:
   navigable kinds are cleared **only** when the original escapes, **never** in the no-original
   case, because a no-original synthetic among them is the rewritten heritage (`extends __X$base`
   pinned onto the source base name) and clearing its flag breaks find-all-references / rename on
   the base name (repro `MIXIN_STRESS_SEED=1479888570`: rename on `Base` came back
   renameable-but-no-locations, `displayName: }`). Generated members have no source counterpart,
   are never navigated to, and otherwise crash the **declaration-emit** path
   (`isDeclarationAndNotVisible → getParseTreeNode(node).kind` on `undefined`) under
   `declaration: true` — the bug that made the IDE show **zero** errors on a *valid* mixin while
   `tsc` reported them (found via `ts-serializable`; guard
   `tsserver-declaration-emit-diagnostics.t.ts`; batch `tsc` never hit it because emit runs over
   reprinted+reparsed source). The kind set is load-bearing: `ExpressionWithTypeArguments` fixes
   cross-file consumer-heritage rename (`getAllSuperTypeNodes → getTypeAtLocation(heritage)` →
   base-type `.flags` crash); `ConstructorDeclaration` fixes `new Box<…>()` on an implements-only
   consumer (its constructor is rebuilt by `addSyntheticSuperCallToConstructors`); and the
   `!inTree(original)` guard must stay — clearing the flag on a node whose original resolves
   *in*-tree (e.g. a type-parameter identifier the checker needs `.original` for) **reintroduces**
   crashes. This took the exhaustive symbol sweep from 68 crashes to **0** with declaration
   diagnostics green. **Span-exactness:** position-preserving generated nodes must report a span
   landing *exactly* on the source identifier, or `stress-quickinfo`/`-definition`/`-references`
   go red on span checks. The consumer type-parameter span (`Consumer<T, A>`'s `A` resolving to
   `T` with a list-wide span) is fixed by collapsing the consumer `$base` off-screen (#8). One
   span fix is its own site: a mixin's rewritten `extends Base` (`consumerHeritageClauses`)
   spanned the whole heritage clause because `expandMixinClass` passed no
   `generatedHeritageTypeRange` — it now passes the source `extends` type, pinning the generated
   `$base` ref onto the source base name (displayString is still the generated `$base` reporting
   `any`; only the span is guarded). Repros `MIXIN_STRESS_SEED=715475832` / `592259738`; guards
   `tsserver-quickinfo.t.ts` ("...consumer's second type parameter" / "...a mixin's source base
   type name"). *Navigating the base name itself in a rewritten heritage clause is a separate,
   partly-open concern — see Current gaps.*

10. **A type/symbol NAME is displayed from its declaration name node's SOURCE TEXT, not its
    `escapedName`.** `getNameOfSymbolAsWritten → declarationNameToString → getTextOfNode` reads
    `sourceFile.text.substring(name.pos, name.end)`; there is **no `escapedName` fallback** for a
    declaration that has a name. So a generated declaration whose name node sits over unrelated text
    (e.g. a synthetic alias anchored at a class' `}`) shows THAT text in diagnostics / hover /
    quickinfo, not its intended name. A zero-width name renders `(Missing)`, and a `pos < 0`
    (synthesized) name is `nodeIsMissing` too — neither recovers the name. In the position-preserving
    source-view plane (no reprint) the only way to display a generated name is to give it REAL
    matching text the checker can read. (Emit is immune: it reprints real text and reparses.) The
    construction config alias depends on this — its current realization is Construction invariant #10.

11. **Source view is position-preserving WITHOUT a source map — never insert *visible* text inside a
    position-preserved span.** The source-view plane does not reprint+remap (that is the emit path);
    the printed transformed text must occupy the SAME offsets as the original so the language service
    works on original positions directly. Generated nodes therefore go off-screen / zero-width (#8)
    and must not shift real code. Inserting characters *inside* a kept node — e.g. a brand parameter
    between a constructor's `(` and its body — shifts everything after it, so navigation / quickinfo
    on the constructor body breaks (lands `any`, highlight spans the whole constructor; `stress-quickinfo`
    catches it). A *range* on the synthetic node does NOT fix it: the problem is that there are more
    characters, not the node's range. The **emit** path reprints and remaps diagnostics
    (`mapPrintedOffsetToSource`), so it CAN absorb inserted text and still land on the real source
    line. This is the load-bearing reason the construction direct-`new` ban for a class with its OWN
    constructor is **emit-only** (the own constructor's signature governs `new`, so the brand must
    poison its parameter — visible text — which only emit tolerates; the no-constructor case brands
    `$base` off-screen and holds in both planes). See Construction invariant #6.

12. **A nested `@mixin` / consumer (declared in a function body or block) expands by recursing
    into nested statement lists; SOURCE VIEW must MUTATE the containing block's `statements` IN
    PLACE, never rebuild the ancestors.** The driver (`transformSourceFile`) walks into `Block` /
    `ModuleBlock` — and `CaseClause`/`DefaultClause`, whose statement lists are NOT blocks — and
    splices the generated siblings into the SAME list (`expandStatementList` +
    `mutateNestedStatementLists`; the range-preservation side is `isRealStatementListOwner` in
    `text-range.ts`), so they share the nested scope and never hoist to module scope.
    The catch is HOW the changed block flows back. Rebuilding the user's ancestors (function /
    block on the path to the nested class) with `visitEachChild` / `factory.update*` sets
    `.original` on those rebuilt USER nodes → pointing at the pre-transform node, which is **not in
    the bound tree**. TS's syntactic node builder then follows `.original` to that un-bound node and
    throws `getSymbolOfDeclaration(...) === undefined → getSymbolId(undefined)` — in **both**
    display-part serialization (`serializeReturnTypeForSignature`, every quickinfo/references on the
    enclosing function) AND declaration emit (`isDeclarationAndNotVisible`). Clearing `.original`
    fixes display but re-breaks declaration emit (#9), so neither rebuild-variant works. **Mutate
    the block in place** instead: the function/block nodes keep their identity — bound, `.original`-
    free — and both planes work. EMIT cannot mutate (its input is the shared host file and it never
    reaches the syntactic node builder), so emit keeps the `visitEachChild` rebuild. Reproduce the
    crash in-process via `ts.SymbolDisplay.getSymbolDisplayPartsDocumentationAndSymbolKind` (a plain
    `createProgram` + `checker.typeToString` does NOT hit it — the tsserver display path does).
    - **`transformSourceFile` must NOT mutate its input.** Because source view mutates in place, it
      re-parses a PRIVATE clone first (`cloneSourceFileForTransform`) and re-derives facts on it,
      scoped to `sourceView && facts.hasNestedClasses`. The compiler host already passes a per-call
      clone, but a direct caller may pass a live, reused source file — e.g. `stress-edit`'s
      incrementally-updated buffer; mutating *that* corrupted its tree and then crashed TS's
      incremental parser (`extendToAffectedRange`) on a later edit (a ~66% flake; the harness
      `try/catch` that "fixed" it was masking THIS bug, not a TS fragility).
    - **Detect a local mixin by its DECLARATION node, not its name** (`context.byDeclaration`).
      `byLocalName` / `byKey` stay first-name-wins (a same-file by-name reference resolves only one),
      but two same-named nested mixins in sibling scopes each expand from their own node. A nested
      mixin shadowing a top-level one resolves correctly because the generated `$base extends M`
      names `M`, lexically the nested one.
    - **Mixin REFERENCES resolve lexically, not by the flat name map**
      (`resolveLexicalMixinRef` in `mixin-refs.ts`): the nearest enclosing-scope class
      declaration of the referenced name answers — with its `byDeclaration` ref (a mixin) or
      with undefined (a PLAIN class shadowing a same-named sibling-scope mixin: the flat
      lookup would expand its neighbour as a consumer and splice machinery referencing the
      plain class — an artifact TS2322 against `RuntimeMixinClassValue` at build and a
      linearization crash at runtime; stress seed 1119868945, pinned as M5b + a corpus case).
      Resolution is an O(same-named entries) lookup in `classScopesByName` — every named
      class with its enclosing-scope range and depth, collected for free during the
      `getSourceFileFacts` pass (which already visits every class once; positions, not
      parent pointers, so program-created files work) — pick the deepest entry whose scope
      contains the reference; a CaseBlock counts as ONE scope (all `switch` clauses share
      it). No per-reference tree walk, which is what keeps `bench:transform` at baseline
      (an earlier per-reference containment descent cost ~2× on the 160-mixin scenario).
      Every reference site goes through it: consumer/dependency heritage
      (`localMixinHeritageTypes*`, `localMixinRefs`), the TS990008 use-before-declaration
      guard, the transitive-heritage reduction, the class-expression consumer diagnostic,
      and the manual-`.mix` ban.
    - **QUALIFIED references** (`implements lib.Logger` via `import * as lib`, and a local
      top-level `namespace NS { @mixin() export class Tagger }` + `implements NS.Tagger`)
      resolve by their DOTTED text in `byLocalName` (two-level `ns.Member` only, no lexical
      walk — a dotted name has no same-file class declaration to shadow it). The ref's
      `localValueName` is the dotted text; `dottedNameToExpression` / `dottedNameToEntityName`
      (entity-name.ts) build the value / type-query forms everywhere a ref value is referenced,
      so never `createIdentifier(localValueName)` directly. Registration: namespace-import
      members in `addQualifiedMixinRefs` (only names some class actually references — the
      namespace exposes the whole module); local-namespace members as DERIVED refs that also
      REPLACE the `byKey` entry (linearized emission must use the qualified name — it is
      valid both inside and outside the namespace). Dependency plumbing is symmetric in
      THREE places, and missing any one breaks subtly: the registry (`dependencyCandidateKeys`),
      the same-file dependency pass (`addSameFileDependencies` — missing it desynced the
      linearization PLAN from the runtime metadata; the runtime `verify` cross-check caught
      it in the fixture corpus), and the construction config accumulation.
    - **Class EXPRESSIONS stay unsupported** (no stable statement slot) but get a clean native
      diagnostic (`TS990002`/`TS990003`), not a bare TS2420. The expressions come pre-collected
      in `facts.classExpressions` (document order) — the diagnostics never walk the file
      themselves.
    - **The facts pass gates its whole-tree walk on a `class`-keyword count**
      (`countClassKeywordCandidates` in `source-file-facts.ts`): the walk's only findings —
      nested class declarations and class expressions — each necessarily put a keyword-shaped
      `class` in the text, so when the count does not exceed the accounted occurrences
      (top-level declarations + occurrences inside import SPECIFIERS, which are strings — the
      package name itself embeds one: `ts-mixin-class`), the walk is skipped. Two load-bearing
      details: the boundary check is ASCII-conservative (a non-ASCII neighbour counts, erring
      toward walking), and specifiers are counted from their RAW source range, not the cooked
      `.text` — a cooked-only occurrence (escape-spelled specifier) charged against the count
      would under-count and skip a walk with real findings (pinned as M14 in
      `nested-scope-declarations.t.ts`). Over-counting (comments, strings, `obj.class`) only
      re-admits the walk.
    - **A class applying a local mixin declared LATER in the same statement list** gets a native
      diagnostic (`TS990008`, spanned on the heritage reference): the generated VALUE reference
      would hit the const TDZ. Emit-plane TS2448 remaps to the import line and source view reports
      nothing, so the native channel is the only faithful signal. Deferred-scope uses stay legal.
      Covers QUALIFIED refs too (`implements NS.Tagger` above the `namespace NS` block — the
      generated `NS.Tagger` reads off a still-`undefined` `var NS`): the guard finds the mixin's
      owning SIBLING statement (the `namespace` for a qualified ref, the class itself for a bare
      one) by POSITION containment over the consumer's statement list and fires only when that
      sibling starts after the consumer. Superseded (kept for context): it used to compare
      `appliedDeclaration.parent` identity + position — but the emit-plane program AST has NO
      parent pointers (only positions survive parse; binding may not have run), so `undefined !==
      undefined` collapsed the parent guard and the check false-fired on a legal deferred-scope
      use (a top-level mixin applied from a nested block) AND skipped qualified refs entirely.
      The position-based sibling lookup (`pushMixinUsedBeforeDeclarationDiagnostics` takes the
      statement list from `expandClassStatement`) is plane-robust — same lesson as
      `resolveLexicalMixinRef`: prefer positions over parent pointers in the transform.
    - **The generated siblings are bound declarations, so scope-level identifier COMPLETIONS would
      offer them** (`__X$base/$empty/$mixin`); the `language-service-plugin` filters them out of
      `getCompletionsAtPosition` (same policy as its navigation-span filtering). Guard:
      `tsserver-completions.t.ts`.
    - **The generated mixin interface carries REAL `get`/`set` signatures** for accessor
      members (TS 4.3 interface accessors) — a split pair keeps distinct read/write types. The
      checker's own TS2610/TS2611 kind-override guards still do NOT fire through an interface
      (they need the base member declared in a CLASS), so `TS990010` re-creates them on the
      native channel (`pushMixinMemberKindOverrideDiagnostics`) — but ONLY under DEFINE
      semantics (`useDefineForClassFields`, threaded into `TransformOptions` by the hosts).
      Under SET semantics both kind-override directions are sound (assignments go through the
      prototype accessor) and stay legal — a deliberate deviation from plain TS, which rejects
      unconditionally. Covers mixin-vs-mixin pairs in one `implements` list and transitive
      local `extends` chains; `.d.ts` mixins are skipped.
      An AUTO-ACCESSOR (`accessor x: T`, TS 4.9) is syntactically a PropertyDeclaration but is
      classified by its RUNTIME kind: it surfaces as real get/set signatures in the generated
      interface and counts as an ACCESSOR in the guard. The one exception to the define-only
      gating: an auto-accessor overriding a DEEPER FIELD is rejected under BOTH semantics — its
      private backing slot is installed only after `super()` returns, so under set semantics the
      deeper field's constructor assignment fires the generated setter before the slot exists
      (a guaranteed TypeError at construction). Guard: `member-kind-collisions.t.ts`,
      `fixture-suite/src/mixin-auto-accessor.t.ts`.
    - **PARTIAL accessor overrides are rejected (`TS990011`,
      `pushPartialAccessorOverrideDiagnostics`)**: JS prototype shadowing replaces an accessor
      per NAME, not per half, so an override declaring FEWER halves than the overridden accessor
      silently kills the missing half at runtime (dead setter → strict TypeError, dead getter →
      `undefined` reads) while the merged type looks whole. Rule: the override's half-set must
      be a SUPERSET of the overridden one (extending is legal). Unlike `TS990010` this is
      semantics-INDEPENDENT (unconditional). The class's own accessors are checked against the
      full LINEARIZED chain (`linearizeDependencies` — transitive deps included; run only when
      the class declares accessors), mixin-vs-mixin only among DIRECTLY listed refs (a mixin
      narrowing its own dependency is reported at the mixin's declaration). Plain-`extends` base
      overrides stay silent (plain-TS territory — TS itself allows every such shape, probed).
      Member-kind extraction is memoized per declaration NODE (`mixinInstanceMemberKindsCache`,
      module-level WeakMap, shared with `TS990010`) — `bench:transform` before/after showed the
      guards at or slightly below the pre-990011 baseline. Guard:
      `partial-accessor-overrides.t.ts`, `fixture-suite/src/accessor-extension-overrides.t.ts`.
    - **Manual `.mix` of a PROGRAM-LOCAL mixin is banned (`TS990012`,
      `pushManualMixinApplicationDiagnostics` in `mixin-diagnostics.ts`)**: inside a transformer
      program mixins compose through the class heritage; `.mix` stays on emitted values for
      EXTERNAL (non-transformer) consumers of the `.d.ts` — so "program-local" =
      `ref.declaration` present OR the registry entry's `fileName` is not a declaration file
      (`isDeclarationFileName`); a `.d.ts`-resolved mixin is exempt. The scan is a per-file walk
      over property accesses `X.mix` (identifier base resolved via `byLocalName`), gated on the
      file text containing `.mix`, anchored on the access. Two structural consequences: (1)
      `transformAppliesToSourceFile` additionally admits a file whose only mixin trace is a
      `.mix` mention + cross-file context — a consumer importing the mixin has no decorator
      import / `implements`, so without the gate widening the scan never ran (this was also WHY
      cross-file `.mix` "worked" in emit and TS2339'd in source view: the file was never
      transformed). (2) The source-view `.mix` APPLY TYPE is DELETED (see invariant #8(a),
      superseded): a source-view mixin value carries NO `mix` member, so a banned use there is
      TS2339 + TS990012 while emit (whose value cast keeps `mix` for external consumers —
      `MixinClassValue` / the generic inline apply type) reports the ban alone; both planes
      agree on TS990012. The dependency-statics `Omit<…, "mix">` in the source-view metadata
      cast STAYS — inheriting a dependency's `mix` would be both a type lie and a hole in the
      ban. Guard: `manual-mix-ban.t.ts`, `tsserver-diagnostics.t.ts` (code rides through the
      IDE), `declaration-fixture-suite/src/package-manual-mix*.t.ts` (the allowed side).
    - **`this`-typed accessors fall back to a PROPERTY signature in the generated interface**
      (`containsThisType` in `interface-members.ts`): a `this` type anywhere inside an
      INTERFACE accessor's annotation crashes plain TypeScript 6.0's checker (a regression —
      5.9.3 clean; 6.0.3 and nightly crash; reported upstream as
      https://github.com/microsoft/TypeScript/issues/63619). Narrowing at the consumer is
      identical through the property form. Remove the fallback when the pinned TS ships a fix.
    - **The factory's runtime class is a named DECLARATION, not a class expression**
      (`class __X$class extends base { … } return __X$class` in
      `createMixinFactoryExpression`), precisely so a mixin's MEMBER decorators are legal in
      BOTH decorator modes — legacy (`experimentalDecorators`) decorators are TS1206 on
      class-EXPRESSION members. They run PER APPLICATION (canonical + each base-less
      consumer), the §1.18 static-block semantics, in both modes; consumer member decorators
      run once. The synthetic name never leaks: self-references in the body bind to the OUTER
      mixin const (no shadowing — the inner name is `__X$class`, not `X`), and the runtime
      renames every application via `setClassName`. Superseded (kept for context): the factory
      used to `return class extends base { … }`, which made a mixin's member decorators
      STANDARD-mode only and kept the runtime fixture excluded from `tsconfig.legacy.json`;
      the declaration shape replaced that, and the exclusion is gone.
    - **USER decorators on a `@mixin` class are re-applied through `defineMixinClass`'s
      `decorate` callback** (`createMixinDecorateCallback` in `mixin-source-view.ts`), INSIDE the
      runtime call, before metadata attachment — so the DECORATED class is the mixin's runtime
      identity (metadata/statics/`.mix`/linearization attach to what the user holds; a post-hoc
      wrap left two identities and broke the C3/replay verify). The UNDECORATED canonical stays
      in `applications` — consumer layers are never decorated; the decorator applies ONCE per
      value. Standard mode emits a REAL decorated class declaration in the callback (`@dec
      class X extends (__mixinValue as unknown as AnyConstructor) {} return X`) so the COMPILER
      emits the TC39 machinery; the inner class is type-erased and callback-scoped — naming it
      `X` is legal (no merge with `interface X` → no TS2310 cycle) and generics never touch it
      (TS2562 forbids type params in base expressions; the public cast is unchanged). Legacy
      mode passes an `__applyLegacyClassDecorators__` fold. The canonical class is
      `setClassName`d BEFORE decoration so decorators observe the real name.
    - **Variance annotations (`in`/`out`) on a mixin's type parameters are stripped when the
      parameters are cloned into SIGNATURE positions** (the factory function expression, the
      generic value-cast constructor type, the `.mix` apply function type) — TS1274 allows them
      only on a class/interface/type alias. The generated interface keeps them (the class
      carrying the user's annotations is erased in emit, so the interface is their surviving
      carrier). `stripVarianceAnnotations` in `util.ts`; guard: `generic-mixin-type-params.t.ts`.
    - **Mixin members need explicit type annotations** (properties, methods, accessors, method
      parameters) — enforced by `collectMixinClassDiagnostics` (TS990004 family) and stated in
      the README. The reason is architectural: the transformer builds the generated interface
      members and declaration output from the AST alone (`buildInterfaceMembers`), before any
      checker exists to infer member types from initializers or bodies — a mixin needs a
      stable AST-level public surface that can be copied into generated declarations.
    - **The ONE reserved static on a `@mixin` is `mix`** — a user `static mix` is rejected in
      `collectMixinClassDiagnostics` (TS990004 family, both planes). The check must skip
      position-less members (`member.pos >= 0`): the source-view path can RE-transform a class
      whose body already carries generated (synthetic) members, and a synthetic node would both
      false-trigger a name match and crash the diagnostic span (`getStart` on pos −1).
      `static new` is NOT reserved anywhere: a user's own `static new` suppresses the generated
      factory (`hasStaticNew`, checked in BOTH `createConstructionMembers` and
      `createMixinConstructionNewType`) and on a construction MIXIN also lifts the
      direct-`new` brand (`brandConstructionBase` excludes `hasStaticNew` — the emit value cast
      falls back to the permissive `MixinClassValue` form, and the planes must agree).
      `super.new` (and required-base / dependency statics generally) inside a mixin's own
      static works on both planes — a former emit gap, closed and guarded by
      `mixin-static-super.t.ts`. The consumer statics bag is
      `Omit<typeof M, "prototype" | "new" | "mix">` — `mix` is excluded like `new` (it lives on
      mixin VALUES only, never on consumers at runtime; carrying it was a type lie and made a
      user `static mix` a TS2417 override conflict).
    - **A GENERIC construction mixin gets the full construction surface** (was excluded): the
      emit value cast's generic branch prepends `"new"<T>(props?: <M>Config<T>): M<T>` (the
      method signature clones the class type parameters, variance-stripped) and swaps the
      permissive construct for the BRANDED generic one (`new <T>(brand) => M<T>`); the
      source-view path reuses `createConstructionMembers`, which already clones type parameters
      onto the generated `static new` (the §7.10 construction-class machinery).
    - **ALL injected helpers are imported under reserved local aliases** — the runtime
      values (`defineMixinClass as __defineMixinClass__`, `__mixinChain__`,
      `__mixinChainLinearized__`) and the type helpers (`type AnyConstructor as
      __AnyConstructor__`, `__ClassStatics__`, `__RuntimeMixinClass__`, ...; the full pair
      table lives in `naming.ts`) — so the injected import can never collide with a
      user's same-named binding OR the user's own import of a helper (TS2440 / TS2300);
      generated code references the local names only. Checker messages still render the
      helpers by their PUBLIC names (`typeToString` prints the type's own symbol, not the
      binding — guarded in `transform-helper-import-collisions.t.ts`). The `.d.ts` mixin
      marker readers (`registry-declaration-file.ts`) match the ALIAS spelling. The
      `language-service-plugin` filters the aliases from completions.
    - **An INSTANTIATED namespace merged with a `@mixin` class** gets a native diagnostic
      (`TS990009`, on the namespace name): the class is rewritten into a `const`, which a
      namespace cannot merge with — the merge would silently lose the namespace exports from the
      mixin's value type. A type-only namespace merge stays legal. Detection is a per-list
      prescan (`pushMixinNamespaceMergeDiagnostics`) — statement `parent` pointers are NOT
      reliable in the emit path, so sibling lookup walks the list itself.
    - Covered by `tests/nested-scope-declarations.t.ts` (emit/runtime/d.ts/diagnostics) and the
      `tests/fixture-suite/src/nested-scope.t.ts` corpus entry (all three planes via the stress sweep).

### Background: an upstream-TypeScript shortcut (not done)

Most of #4/#5/#8 exist only because tsserver **crashes** on a position-imperfect synthetic AST.
Two one-line relaxations in TypeScript would dissolve those crash *classes* (provably no-ops for
normally-parsed programs — the failing branches are unreachable unless an AST range fails to
cover a source identifier, which only a transform produces):

- `services.ts`, `addSyntheticNodes`: the `Debug.fail("...Identifier in its trivia")` (#5)
  already has a `hasTabstop(parent)` escape that does `continue` (added for snippet completions,
  themselves synthetic ASTs). Generalising that `continue` to **any** identifier in a trivia gap
  removes the #5/#8 crash class.
- `checker.ts`, `forEachSymbolTableInScope`: `getSymbolOfDeclaration(location).members` (the
  `reading 'members'` crash) — a `?.` guard degrades to empty for unbound synthetic class-likes.

**Caveats** (not a silver bullet): (1) these are two *sites*, not immunity — synthetic ASTs trip
an open-ended set of assertions (`getErrorSpanForNode` "20809", `resetTokenState`'s `pos >= 0`).
(2) Relaxing a *crash* yields a non-crashing but possibly **wrong** result (`getChildren` skips
the stray identifier → `getTokenAtPosition` may return a different token), so the exact-span /
rename-location *correctness* checks still require faithful ranges. The patches turn "crashes"
into "soft quality concerns"; they would not make the stress tests green on their own.

## Construction `new` invariants

The generated construction `new` (so `Mixin.new(...)` / `Consumer.new(...)` returns the right
instance type) has its own rules:

1. **The two paths emit *different shapes*; both must be handled.** Emit turns a `@mixin` class
   into a value-cast (no class body) → the construction `new` is a member *prepended to the cast
   type*. Source view keeps a real class → `new` is a `static new` *class member*. A one-path fix
   leaves the other broken; verify with both `tsc` and `tsc --noEmit`.

2. **In a type literal, `new(...): T` is a construct signature, not a property named `new`.** To
   put a callable `.new` on a value-cast type, use a **property signature** `new: (props?) =>
   Instance` (`createPropertySignature` + function type), **not** `createMethodSignature("new",
   …)` (which prints `new (...) => T` → TS2339 "Property 'new' does not exist"). A method literally
   named `new` is only expressible in a **class** (`static new`), which is why source view can use
   a method and the emit value cast cannot. `declare` does not rescue the value cast (not a
   type-literal concept; in a class allowed only on property/field members, not methods —
   `declare static new(...)` → TS1031; only `declare static new: (...) => T` is legal, which
   reintroduces #3's strict variance). So the source-view `static new` is a real method needing an
   implementation body (or overload + impl, else TS2391).

3. **Property-typed `new` is checked contravariantly (strict); a class `static new` is
   bivariant.** A consumer generates its own `static new` (often with *more* required config). If
   it *inherited* a mixin's value-cast `new` (a property → strict params), the consumer's stricter
   `new` would be an incompatible static-side override → TS2417 "Class static side ... incorrectly
   extends". So a consumer **excludes `"new"` from every applied mixin's inherited statics**:
   `Omit<typeof Mixin, "prototype" | "new">` (`createMixinStaticsType`), not `ClassStatics<typeof
   Mixin>`. The consumer's own `new` wins.

4. **Config keys come from DECLARED class members only — constructor parameter properties are
   NOT config keys, by design.** `collectClassMemberFacts` (`source-file-facts.ts`) walks
   `declaration.members` (public fields + settable accessors); a parameter property is a
   ParameterDeclaration inside the constructor and is deliberately not collected — it stays a
   runtime/interface member whose value comes from the constructor (the native-construct step).
   PIN THE ALIAS TEXT (`Pick<X, "declared">`), never a loose `.d.ts` substring: `tag?: string`
   also occurs in the emitted `constructor(tag?: string)` signature, which is how two pins were
   green against an EMPTY config (`Partial<Pick<X, never>>` accepts any object literal with no
   key checking). Guard: `construction-parameter-property.t.ts`,
   `construction-mixin-config-shapes.t.ts` (the mixin twin).

5. **Config-key required-ness comes from the definite-assignment `!`, not the initializer or `?`.**
   `public id!: T` is a **required** config key; every other public field is **optional** (the `?`
   token is irrelevant to the config — it is ordinary TS optionality). Only `public` members enter
   the config. Required-ness is read from `member.exclamationToken` in `source-file-facts.ts`,
   *before* any field rewriting — so stripping the `!` later (next bullet) does not change the role.
   - **`!` + initializer is normalized away.** TS forbids an initializer on a `!` field (TS1263),
     yet a required key may want a default. So `construction-initializers.ts` strips the `!`
     whenever the field ends up with an initializer (user-written, or one `fillMissedInitializersWith`
     added), emitting a clean `id: T = ...`. The strip runs in **both** paths and even when filling
     is `"nothing"`, so `id!: T = v` always compiles. A `!` field left with no initializer keeps its
     `!` (it satisfies `strictPropertyInitialization`).
   - **`fillMissedInitializersWith` (default `"undefined"`).** Any *instance* field with no source
     initializer is given one — **of every visibility** (public/protected/private/unmarked), since a
     stable object shape is a runtime concern independent of config/visibility; only `static`,
     `abstract`, `declare`, and untyped fields are excluded (see `isFillableProperty`). So every
     instance has the slot (stable V8 object shape → monomorphic access). The value is a **non-null
     assertion** (`undefined!` / `null!`, type `never`) so it assigns to ANY field type without
     widening it (`number`, not `number | undefined`), printing to `.js` as `field = undefined`/`null`.
     `"null"` / `"nothing"` are the other modes. **Invariant: this rewrite is emit-safe even on
     non-construction fields** — strip-`!`-plus-fill produces output identical to leaving the field
     alone when it already has a real initializer — which is why a blanket "add `!` to every required
     field" test migration is safe. **Invariant: adding a synthetic initializer / stripping a `!` in
     the source-view path does NOT strand** (unlike a synthetic *named reference*, invariant #5):
     an initializer expression and a punctuation token carry no symbol to resolve. The whole stress
     + tsserver suite is the arbiter (it stays green).

6. **Direct `new` on a construction class is disabled by a *branded construct signature*, not a
   `protected` constructor.** A construction class's heritage cast head replaces the public construct
   signature with `new (use_the_static_new_factory: { readonly "<guidance>": never }) => <base
   instance>` plus inline `Omit<typeof Base, "prototype">` statics (`constructionHeadType` /
   `ConstructionBrand` in `construction-brand.ts`). `new X()` → TS2554 (param name guides), `new X({...})`
   → TS2353 (the descriptive key surfaces). A `protected` constructor is **wrong** here: it makes the
   class value unassignable to any public `new(...)=>T` slot (breaks `.mix(...)`, `isInstanceOf`,
   generic `AnyConstructor` consumers) and is structurally unfixable (`abstract new` also rejects it).
   The brand is only a *parameter type*, so assignability is preserved. Gotchas, all load-bearing:
   - **Return type by mode.** Source-view head returns `object` (the `$base` interface always
     re-extends the base → carries the instance; naming it would double-extend, TS2320, or reference
     a consumer type param in a base expression, TS2562). Emit head returns the precise base type
     (`heritageTypeToTypeReference`) when the base has **no** type arguments (the emit `$base`
     interface does *not* re-extend it, so `initialize`/base fields flow only through this return —
     `object` drops them), but `object` when it **does** (interface already carries the generic base).
   - **Brand site depends on whether the class declares its own constructor.** `$base`'s construct
     governs an external `new` only when the class has **no** constructor of its own; with a
     constructor, the class's **own** construct signature governs, so branding `$base` is useless
     there (and would break its `super(...)`). Two sites:
       - **No own constructor →** brand `$base` (above), both planes. The class inherits the poisoned
         construct.
       - **Own constructor →** keep `$base` permissive (`new (...args: any[]) => instance`,
         `ConstructionBrand.branded = false`, so `super()` resolves) and instead poison the
         constructor's OWN first parameter (`brandConstructorParameter` in `construction-brand.ts`). The
         construct stays public, so `AnyConstructor` assignability holds. This inserts a parameter,
         which shifts the constructor body — so it is **EMIT ONLY** (the emit diagnostic remap
         absorbs the shift; position-preserving source view cannot, so the IDE leaves a
         with-constructor construction class un-banned and the build is what catches the stray `new`).
         A mixin's emit value cast achieves the same ban without touching the constructor (the factory
         applies an unbranded `base`), so a construction **mixin** is banned in emit whether or not it
         declares a constructor.
       - *Superseded (kept for context):* originally a class with its own constructor was **never**
         branded — it "opted into manual construction" and a direct `new` stayed allowed (commit
         `b9bf1e1`). That left the `new`-bypasses-`initialize()` footgun open for such classes; it is
         now closed on the emit plane by the own-parameter brand above.
   - **Imports.** The head inlines `Omit`/`InstanceType` (global lib utilities) so the
     mixin-less construction path — which never requests generated imports — needs none.
   - **Runtime is untouched** (the brand lives only in the `as unknown as` cast, erased on emit), so
     `new X()` still *runs*; it is purely a compile-time guard.
   - **Diagnostic position parity for the generated `static new`.** A diagnostic *inside* the
     synthetic member (e.g. a perturbed config key in `Pick<…>` failing `keyof X`) must land on the
     same source line+column in emit and source-view. Anchor the members at `declaration.members.end`
     in **both** modes (`createConstructionMembers` callers) — `declaration.pos` includes leading
     trivia and remaps emit onto the *previous* class's `}`. And in emit, `collapseSubtreeTextRange`
     the whole member to that anchor: otherwise an interior node has no mapping of its own and the
     emit remap extrapolates its column to the line end, one past source-view. `stress-diagnostic-parity`
     guards both (it perturbs `@mixin` names, which cascade into a subclass's generated config).

7. **A base contributes its *fully accumulated* config to a subclass's `.new`, not just its own
   fields.** A construction class can extend another construction class, which may itself be a
   consumer (it extends a further base **and** implements mixins). The generated `.new` config for
   the subclass must fold in, recursively: the base's `extends` chain, every mixin the base consumes
   (and those mixins' transitive mixin dependencies), and the base's own `public` fields. Reading
   only the immediate base's own fields silently drops inherited config **and** makes the subclass's
   `static new` an incompatible static-side override along the chain (TS2417). Two code paths must
   stay in sync: `baseConfigProperties` / `configPropertiesForName` (`construction-chain.ts`) for a
   **local** base, and `buildConstructionBaseRegistry` (`registry.ts`) for an **imported** base —
   the latter now resolves the base's `implements` mixins through the mixin registry, not only its
   `extends` chain. Both share `accumulateRegisteredMixinConfig` (`model.ts`). This regressed once
   because the only fixtures were one level deep (`X extends Base` directly); keep
   `construction-deep-subclass.t.ts` and the cross-file deep-subclass test honest.
   A **QUALIFIED base** is followed in both paths. Locally (`extends data.Model` through a
   local namespace) via the local-namespace index (`qualifiedLocalClassFacts` /
   `classesByQualifiedName`, `source-file-facts.ts`), keyed in the `seen` sets by its dotted
   text (disjoint from plain identifiers); a dotted name that is NOT a local namespace path
   falls back to `resolveCrossFileConstructionBase`, which follows a one-dot name through its
   namespace-import binding into the registry (`extends lib.Model`). The registry resolves a
   candidate's qualified base at collection time with `qualifiedConstructionChainExit`
   (`construction-chain.ts`): the file-local walk (a nested class is never a candidate
   itself) either terminates at the package `Base` import or exits at an unresolved reference
   — an imported identifier or the dotted namespace-import member — which becomes the
   candidate's `baseName` for the ordinary imported-candidate `resolve` recursion; the local
   levels contribute `qualifiedBaseConfigProperties`. Guarded by
   `construction-qualified-base(-subclass).t.ts`, `construction-namespace-import-base.t.ts`
   and `construction-qualified-imported-chain(-subclass).t.ts`. Candidate collection is
   TWO-PHASE: the text prefilter (`sourceFile.text.includes(packageName)`) admits every file
   that can anchor a chain (the package `Base` import lives in one — phase 1), then a fixpoint
   admits each remaining PACKAGE-FREE file with a top-level class whose base reference
   resolves through its imports into an already-collected candidate (phase 2,
   `fileChainsIntoCandidates` — files admitted in one round can anchor the next; a raw
   statement scan dismisses files with no import or no extending top-level class before any
   facts are built). Superseded (kept for context): the prefilter used to be the ONLY gate, so
   a construction consumer declared in a file that never mentions the package could not be
   registered, and subclassing it from yet another file silently lost construction. Guarded by
   `construction-package-free-chain.t.ts`.

8. **Construction survives the `.d.ts` package boundary.** Detection must work when the provider is
   consumed as published declarations, not source. (i) A `.d.ts` mixin's required base lives in its
   `RuntimeMixinClass<Base>` marker, not an `extends` clause; `collectDeclarationFileMixinCandidates`
   reads it back (and drops the package base from the merged `interface … extends Base` dependency
   names) so a consumer of an imported `.d.ts` construction-base mixin is construction-enabled.
   (ii) A `.d.ts` construction *class* carries its fully aggregated config on the emitted `static
   new(props: <Name>Config)`, alongside an exported `declare type <Name>Config = Pick<Self, …> &
   Partial<…>`; `buildConstructionBaseRegistry` scans declaration files, resolves that alias
   reference to its body (`collectDeclarationFileConstructionBases` + a same-file type-alias map), and
   reads the config off the `Pick`/`Partial` (still no recursion through the extends chain). Both are
   guarded by the declaration tests in `source-transform-cross-file-construction.t.ts`.

9. **The generated `static new` name needs a real source span in source view.** A FAILING
   `.new(...)` call elaborates the failure against the *implementation* overload
   (`addImplementationSuccessElaboration`), computing an error span on its `new` name. A
   factory-fresh name (pos/end = -1) trips `getErrorSpanForNode` (`skipTrivia(-1)` overruns the node
   end → `Debug.assert` / TS #20809) and **crashes the compiler** — only across files / in source
   view (emit reprints to real positions; single-file source view happens not to elaborate). Pin the
   name to the first overload's anchor (`createConstructionMembers`, source-view branch); the method
   node keeps its own per-overload range for the overload-adjacency check. Guarded by the "without
   crashing the compiler" test.

10. **The exported `<Name>Config` alias is a sibling, anchored OUTSIDE the class.** Every construction
   class (consumer, plain `Base` descendant, and construction-base mixin — emit *and* source view)
   emits an exported `type <Name>Config<TParams> = <the config>` and the `static new` references it
   (`static new(props: <Name>Config)`), so `.new(...)` errors name the alias instead of a verbose
   `Pick<…>`. The alias name is `<ClassName>Config`, suffixed with `_` on collision with a file-local
   name (`constructionConfigAliasName`).
   *Displaying the alias name in source view (current realization of source-view invariant #10).* A
   synthetic alias has no real `<Name>Config` text, so the editor would print `parameter of type '}'`
   (it reads the name node's source position — the class' `}`); emit is immune (it reprints). So in
   source view the transform **appends each generated alias as REAL text past the original file end**
   (`appendGeneratedConfigAliasesAsRealText`): printed from a synthetic clone, reparsed for real
   `[N, …)` positions, and the synthetic node swapped for the reparsed one. Appending never shifts the
   `[0, N)` offsets, so user code stays correct, and the checker reads the real name in diagnostics,
   hover and quickinfo (incl. generics, `BoxConfig<number>`). The appended tail is LIVE for the
   language service, so the companion **`language-service-plugin`** (a `ts.server.PluginModule`, built
   CJS via `tsconfig.lsplugin.json`, configured as a SECOND editor plugin) drops navigation spans
   starting past the on-disk document length and REMAPS a go-to-definition hit on the appended alias
   back to the owning class. Without it, find-references / rename / definition return phantom tail
   spans (caught by the `stress-references` plane). Guarded by `tsserver-construction-config-alias.t.ts`.
   It is listed AFTER the class and `positionConstructionConfigAlias` collapses the whole subtree
   to one real anchor at `declaration.end` (the gap just past the closing brace). That anchor is
   load-bearing for EMIT; **source view supersedes the position** — the append swaps in the
   reparsed tail node, so the alias's source-view span is in the tail, not here. Two constraints
   force the exact emit anchor:
     - an *in-class* anchor (`members.end`) overlaps the class and strands an identifier in trivia
       (invariant #5), so it must be OUTSIDE the class;
     - a `[-1,-1]` (off-screen) collapse scatters a perturbed-config diagnostic to an unrelated line
       and breaks stress parity, so it must be a REAL position (like the `static new` members).
   `positionConstructionConfigAlias` also sets the alias's `.original` (the class), which the append
   step reads to detect it.
   - **Superseded (kept for context):** a third constraint once forced a real *in-tree* position. The
     alias is source-referenced (`initialize(config?: <Name>Config)`) and its `.original` (the class)
     escapes into the unbound source-view clone, so a real position let
     `alignGeneratedNavigableNodesWithParseTree` clear the alias's `Synthesized` flag (it was listed in
     `isNavigableGeneratedNodeKind`) and `getParseTreeNode` resolve it to itself, instead of walking
     into the clone and crashing find-references / quickinfo display in `forEachSymbolTableInScope`.
     This no longer applies: the append replaces the synthetic alias with a **real reparsed node**
     (never synthetic, no `.original`), so the alignment pass cannot act on it — `TypeAliasDeclaration`
     was dropped from `isNavigableGeneratedNodeKind`. (The constraint still holds for the analogous
     `MethodSignature` protocol member below, which is NOT appended.)
   Guarded by the alias tests, `tsserver-construction-config-alias.t.ts`, the
   `construction-config-alias-usage.t.ts` corpus fixture (so every stress probe targets the alias
   identifier), the stress parity corpus, and the trivia-strand test.
   `Base.initialize`/`Base.new` are typed `unknown` (not the removed `Config<T>` helper) so any class
   — including a `@mixin` — may override `initialize` with its strict `<ClassName>Config` alias
   (method-parameter overrides are bivariant). A consumer (or a construction mixin) applying several
   mixins that each override `initialize` would otherwise hit TS2320 (its generated
   `interface <C>$base extends Base, A, B` inherits non-identical `initialize` members); the generated
   `$base` interface re-declares the `Base.initialize` protocol member to override the conflicting
   inherited ones — for consumers (gated by `isConstructionConsumer`, in consumer-expand) and for
   construction mixins with dependencies and no own override (gated by `isConstructionBaseOptIn` +
   `declaresInstanceInitialize`, in mixin-expand). That member is synthetic, so `MethodSignature` is in `isNavigableGeneratedNodeKind`
   — in source view it normalizes onto the off-screen `$base` range and the alignment pass clears its
   `Synthesized` flag, so rename/definition on a user `initialize` does not crash
   `forEachSymbolTableInScope`. Guarded by `source-transform-construction-config-alias.t.ts`,
   `tsserver-construction-config-alias.t.ts`, and the cross-file "imported mixin … including its
   initialize override" test.

## Emit-path diagnostic remapping

The emit path **reprints** the value-cast tree to text and reparses it. This is mandatory — only
the value-cast form emits correct runtime JS, and it must be reparsed to be a coherent file (a
non-reparsed value-cast tree makes the checker *invent* diagnostics: TS2391, TS2578, etc.; the
position-preserving source-view tree is types-only and emits wrong JS). But expansion adds/removes
lines, so diagnostics over the reprinted text land on **regenerated lines that do not exist on
disk** — `tsc`/CI then reports at the wrong line.

**Resolution — remap diagnostics, never the tree.** `printSourceFileWithMappings` (in `util.ts`)
prints via the internal `printer.writeFile` + `createSourceMapGenerator`, capturing the printer's
source map (unchanged user statements keep their original nodes, so their mappings are exact).
Each reprinted file is stamped with that map + its original source file via
`attachDiagnosticRemap`. `wrapProgramDiagnostics` wraps the program's
`getSyntactic/Semantic/DeclarationDiagnostics` + `emit` so every stamped diagnostic is rewritten:
`start`/`length` translated back through the map and `.file` swapped to the **original** source
file. The translation binary-searches the **greatest source-map entry `<=` the printed
position**; a *transformer-generated* diagnostic (e.g. the validation alias TS2344) sits on a
fully-generated line where many printed columns collapse onto one source column, so the column
advance is **capped at the next entry on the same source line**, and a line with no entry falls
back to the nearest preceding entry (still line-accurate). Guards:
`emit-source-view-diagnostic-parity.t.ts` (exact line+column for one controlled error) and
`stress-diagnostic-parity.t.ts` (corpus sweep — its header comment is the full compiler-vs-IDE
diagnostic breakdown). A filtered audit over all 1273 non-heritage/non-base perturbations found 0
line drifts and 0 column mismatches. Do **not** fix this by changing which tree emit uses — both
alternatives were proven to break (runtime JS / invented diagnostics).

**Name rewrite at the same seam** (`diagnostic-name-rewrite.ts`): checker messages that embed a
base-class NAME show generated artifacts after the transform — `'__X$base'` on emit; in source
view the collapsed `$base` range renders as `'}'`/`'typeof }'` or the metadata-cast intersection
text (`'Machine & Greeter'`) — because the checker prints a type's name from its declaration
name node's SOURCE TEXT (source-view invariant #10). `rewriteGeneratedNameDiagnostics` (called
after the position remap, per-diagnostic gated on an artifact pattern) resolves the member at
the span against the ORIGINAL file (both planes carry original positions there) and walks the
class's mixin layers in C3 order over the REGISTRY (reusing `linearizationCache`), then the real
base chain — the first DECLARING layer is the name in the message; no owner → the user-level
combined display. `typeof __X$class`/`ClassStatics<typeof R>` unwrap textually. All quoted-name
replacements are exact-keyed and fire only when a replacement resolved. TS2416 fires TWICE by
construction (the user's `implements` reference + the generated heritage); the rewrite makes the
artifact twin byte-identical and an exact-duplicate pass drops it — do not "fix" the double
report upstream, the twin is load-bearing for the implements conformance check. A NESTED
construction class's in-block `<Name>Config` alias is the one generated node whose collapsed
name can surface OUTSIDE a base-name context — a message printing the alias SYMBOL (e.g.
TS2315) renders a bare `'}'` (the append-real-text trick works only past the document end, so
an in-block alias stays synthetic); the span sits on the user's own alias reference, so
`configAliasNameAtSpan` reads the real name from the original text at the span (gated on the
`<Name>Config` shape with class `<Name>` present, and on an UNAMBIGUOUS single `'}'`). The
HOVER twin of that render (`type } = {...}`) is fixed at the language-service-plugin seam
instead: the plugin substitutes the hovered reference's text into the collapsed `aliasName`
display part. The same plugin seam normalizes the generated `.new`'s METHOD NAME on quickinfo,
signature help and completion details: the name node is pinned to a ONE-CHAR anchor (a
factory-fresh name crashes the checker's error-span machinery on a failing `.new(...)` —
`createConstructionMembers`), so member-name display reads that single source character
(`TopPoint.r`, `Timed[0]`, `Point[}]`); the real name is statically `new` and each request
provably targets it (hovered identifier / callee before the arguments span / requested
completion entry). Guards: `diagnostic-base-names.t.ts`, the §2.23 pins in
`compiler-option-edges.t.ts`, `mixin-static-super.t.ts` (TS2417),
`tsserver-construction-config-alias.t.ts` (the nested hover + the `.new` name surfaces).

## Emit-path source-map composition

Same root cause as the diagnostic remap, applied to **emitted source maps**: the emit plane
compiles the reprinted text under the original file name, so the map tsc writes is
`generated (JS / .d.ts) → printed` while the file on disk holds the ORIGINAL text — before the
fix every user position below the first generated insertion drifted, up to **beyond the original
EOF** (breakpoints on wrong lines, lying stack traces). `emit-source-map.ts` composes the second
leg at the `program.emit` seam in `wrapProgramDiagnostics`: when the compilation asks for maps at
all (`sourceMap` / `inlineSourceMap` / `declarationMap`), the emit's `writeFile` is wrapped —
every `*.map` (and the base64 data-URI map inside a `.js` under `inlineSourceMap`) is decoded
(TS-internal `decodeMappings` via `decodeSourceMapMappings`, co-located in `emit-source-map.ts`), each segment's source position is rewritten through
the reprinted file's attached `DiagnosticRemap`, re-encoded (own base64-VLQ encoder — TS exposes
no encoder), and written to the caller's `writeFile` or, on the plain-`tsc` path, the host's.
`inlineSources` gets the ORIGINAL text substituted into `sourcesContent` (tsc embedded the
reprint). A file the transform leaves untouched passes through **byte-identical** to a
plugin-less build.

Two policies differ from the diagnostic remap on purpose:

- **Same-line only, no preceding-line fallback.** A printed line with no remap entries is fully
  generated; its segments are DROPPED (the debugger falls back to raw generated output — the
  standard behaviour for generated code). The diagnostic remap's preceding-entry fallback would
  pin generated statements onto user lines.
- **Token agreement.** The remap also carries entries for generated statements collapsed onto
  gap ranges (the diagnostics' `'}'` family) and for generated references pinned onto user spans
  (`extends __X$base` onto the user's base name). When the printed position starts an
  identifier, the identifier at the translated original position must be the same word, else the
  segment is dropped — user identifiers survive the reprint verbatim; generated names never
  match their collapsed anchors. Punctuation stays unverified (quote-style normalization must
  not drop real mappings).

tsc's own conventions survive composition where the words agree: a synthesized `constructor`
maps to the (user) class header, a hoisted field initializer to the field name, `get`/`set` to
their `override` modifier, and declaration emit's synthesized `declare const <Class>_base` (a
class extending an EXPRESSION — the runtime chain or the construction direct-`new` brand) keeps
its reference mapped to the user's base name. Guards: `emit-source-map.t.ts` (exact per-token
pins incl. those conventions, artifact-token ban, bounds, `return`-line completeness, untouched
byte-identity, inline + declaration + declaration-only + NodeNext variants, drift zones BETWEEN
insertions incl. a function-nested consumer, same-basename files in different directories,
CJK identifiers — outside the ASCII token filter — and emoji columns, CRLF sources,
runtime stack traces via `node --enable-source-maps`, and a `tsc --watch` emit rebuild mapping
against the EDITED text) and `stress-sourcemap.t.ts` (corpus sweep under BOTH
`useDefineForClassFields` values: bounds, token agreement with the tolerated-word set DERIVED
from a plugin-less baseline of the same corpus, `return`-line completeness, untouched identity —
"untouched" detected exactly: the program serves the file with its on-disk text — a byte-exact
VLQ-encoder round-trip over every baseline map, plus a seeded identifier-perturbation pass,
replayable with `MIXIN_STRESS_SEED`). The watch plane found a pre-existing crash: `tsc --watch`
WITH emit builds a BuilderProgram, which asserts every source file carries the host's `version`
— a reprinted file must inherit it (`preserveSourceFileVersion`; every prior watch test ran
`--noEmit` and was structurally blind to this, the same lesson as `impliedNodeFormat`).

## Emit-path implements conformance

The sweep also exposed that the value-cast (emit) and real-class (source-view) trees are not
type-*equivalent*: emit **under-reports** mixin-contract errors source view catches. The trees
can't be unified (emit needs a runtime *value*, source view a navigable *class* — one face each),
so the lever is to re-impose the lost check *within* the emit tree.

The value-cast form (`const X = defineMixinClass(...) as unknown as <type>`) erases the structural
check between the runtime mixin body and the contracts it `implements`: the `as unknown as`
force-types the value, and the generated `interface X extends Contract` *inherits* the contract's
members rather than checking the class against them. So `tsc` stayed silent on a mixin missing a
required member while `--noEmit`/the IDE flagged it (TS2420). **Resolution — carry the `implements`
clause on the factory's inner runtime class, don't touch the value/emit.**
`createMixinFactoryExpression` builds the body as `class __X$class extends base implements
Contract1, … {…} return __X$class` (`mixinFactoryHeritageClauses` clones the mixin's own
`implements` types onto the inner runtime class — a named DECLARATION, not an expression, so
legacy member decorators stay legal). An `implements` clause is **type-only — erased in JS**, so
runtime output is byte-identical, but it makes the checker verify the *real* body against each
contract. `base` is typed `AnyConstructor<RequiredBase & deps> & ClassStatics<typeof
RequiredBase> & Omit<ClassStatics<typeof Dep>, "mix" | keyof RuntimeMixinClass>` — instance AND
static sides (originally instance-only — superseded, kept for context: the statics were added so
`super.<baseStatic>` / `super.new` type-check inside a mixin's own `static` body, and the
static-side extends check TS2417 fires on emit exactly as source view always ran it; pinned in
`mixin-static-super.t.ts`). Members inherited from the required base / deps are satisfied through
`extends base`. Two invariants ride on the statics: (1) a construction mixin's value cast must
DROP the `new` inherited through `ReturnType<Factory>` (`Omit<…, "new">` in
`ConstructionMixinClassValue` / the generic inline cast) or the permissive inherited `Base.new`
wins overload fallback next to the generated `.new`; (2) dependency statics must strip the
symbol-keyed markers (`keyof RuntimeMixinClass`) or DECLARATION emit of the exported factory hits
TS4023/TS4025 (the inner class's static side expands structurally and cannot name the runtime
module's symbols). This works **uniformly for generic and
non-generic mixins** — the type parameters are in scope inside the factory (`function <T>(base) {
class __X$class … implements Container<T> {} … }`), which the earlier `interface extends` /
top-level-alias forms could not express.
**Position:** TS2420 on a class declaration is reported at its NAME; the synthetic name (and the
declaration) are pinned to the mixin's source name (`preserveTextRange(…, declaration.name)`) so
emit reports the **same TS2420 at the same line and column** as the IDE. Guards: `emit-contract-conformance.t.ts` (non-generic missing, generic
missing, satisfied → no false positive) and the corpus parity sweep (33 seeds). The remaining
downstream-*consumer* propagation is still open — see Current gaps.

**`isolatedDeclarations` (gated factory return annotation).** Under the option (threaded into
`TransformOptions.isolatedDeclarations` by the hosts) the factory gets an EXPLICIT return
annotation (`createFactoryReturnType`): real own-constructor signature (or `AnyConstructor<X>`),
own statics literal (`createFactoryStaticsLiteral` — a static `new` MUST keep a STRING-LITERAL
member name: the reprint round-trip reparses an identifier `new(…)` in a type literal as a
CONSTRUCT signature), and the base/dependency statics tail (`baseStaticsTypes`, shared with the
base parameter) with the class's OWN static names shadowed (class semantics — otherwise the
base's permissive `new` stays a live overload next to a user's own). The return statement is
CAST to the annotation (structural checking would reject TRUSTED declaration-merged interface
members). GATED, not always-on: the tail references dependency VALUE types whose annotations
nest further — `Omit<ClassStatics<…>>` chains hit the checker's instantiation-depth ceiling
(TS2589) on deep dependency windows (caught by `bench:compile`'s 8-window fixtures), while the
default inferred `typeof __X$class` is a flat class type. Guards: `isolated-declarations.t.ts`
(incl. a cross-package PLUGIN-LESS consumer via the `Mix<M, B>` recipe — the public helper in
`base.ts`), and the declaration corpus builds with the option on.

## Symptom → cause

The same crash text has several possible causes; check in this order before assuming the obvious.

| tsserver / checker message | likely cause |
| --- | --- |
| `Did not expect ... to have an Identifier in its trivia` | a NodeArray with `pos/end === -1` (#4 trap) **or** a real gap over an identifier between siblings (#5). Check `members.pos/end` first. |
| `Debug Failure ... resetTokenState` / `pos >= 0` | a synthetic NodeArray never range-stamped (#4). |
| `Cannot read properties of undefined (reading 'flags')` in `tryGetDeclaredTypeOfSymbol` | a generated declaration whose `name` node has no original / no resolvable symbol (#6). |
| `Cannot read properties of undefined (reading 'members')` on quickinfo/rename | a generated navigable node whose `.original` escapes the returned tree, flag not cleared (#9). |
| `Cannot find name 'T'` (TS2304) on a type parameter | a node shared between two declarations; `cloneNode` is shallow (#1). |
| type annotation silently `any`, identifier shows `(Missing)` | a zero-width range (#2). |
| TS2391 "Function implementation is missing" on the `static new` triple | non-consecutive overload ranges (#3). |
| TS2339 "Property 'new' does not exist" on a mixin value | the value-cast `new` was built with a method signature (→ construct signature) instead of a property signature (construction #2). |
| TS2417 "Class static side ... incorrectly extends" on a consumer | the consumer inherited an applied mixin's value-cast `new` instead of omitting it (construction #3). |
| construction bug reproduces under `--noEmit`/IDE but not `tsc` (or vice-versa) | the fix touched only one of the emit / source-view paths (construction #1). |
| `Unsupported base class expression of a mixin consumer` thrown mid-edit | a heritage expression that is not a plain reference reached `expressionToEntityName` from an **unguarded** path. The principled entries filter via `isSupportedBaseExpression` (`requiredBaseType`, consumer base guard); the source-view mixin apply-type mapped `implements` heritage **without** that filter. `expressionToEntityName` now degrades to a placeholder name instead of throwing — the transform must never throw on a transient edit state (`stress-edit` contract); pinned by `transform-survives-unsupported-mixin-base.t.ts`. |
| `Could not determine parsed source file` / `Unsupported base class expression`, only in tsserver while typing | the transform threw on a transient incomplete-syntax node (#7). |
| a diagnostic appears on **unrelated** code after an edit and persists until server restart | the transform threw mid-edit; tsserver serves the untransformed fallback for the whole project (#7). |
| TS2304 in **emit** *and* TS2562 in **source view**, on a `@mixin` that `extends` a generic base | the mixin's own type parameter leaked into the `RuntimeMixinClass<Base<T>>` marker — must be erased to `any`; see `eraseOwnTypeParameterReferences` (Current gaps → Resolved). |
| TS2720 / TS4112 on a consumer extending a navigable-base cast | the single-source cast had a competing construct signature (a bare `typeof Base`), stranding the mixin members; statics must be `Omit<…,"prototype"|"new">` bags (Current gaps → heritage navigation). |
| a failing `.new(...)` shows `parameter of type '}'` **only in the editor** (emit names `<Name>Config`) | TS displays a type alias by reading its declaration name node's SOURCE TEXT; the synthetic alias is anchored at the class' `}`. Source view must append the alias as REAL text past the document end so the real `<Name>Config` name is read (`appendGeneratedConfigAliasesAsRealText`, #9); pinned by `tsserver-construction-config-alias.t.ts`. |
| find-references / rename / go-to-definition return a phantom span **past the file end** in the editor | the appended alias text (#9) is live for the language service; the `language-service-plugin` companion must be configured to drop / remap those spans. The `stress-references` plane catches a missing/broken filter. |

## Current gaps

### Heritage-clause navigation (closed for every explicit-base class)

go-to-def / find-all-references / rename / quickinfo on a base type name *inside* a rewritten
`extends` clause **reaches the real base for every well-typed class with an explicit
entity-name base** — plain, GENERIC, CONSTRUCTION and QUALIFIED (`ns.Base`) consumers alike,
**and a `@mixin` class's own required-base heritage** (`expandSourceViewMixinClass` takes the
same `navigableConsumerBaseClassHeritage` fast path, skipping the `__X$base` pair: the
required base + dependency instances ride in the construct signature — an intersection, so no
`protocolInitialize` TS2320 mediation — and the mixin's `RuntimeMixinClass<...>` metadata
joins the cast statics via the `extraStaticsTypes` parameter). The former gate to
non-generic, non-construction, identifier-only bases is superseded (kept for context below);
the trilemma exits:
- **generic consumers**: TS2562 bans the consumer's type parameter only in the base
  EXPRESSION — the navigable cast's construct signature is generic (clones of the consumer's
  parameters, variance stripped) and the heritage instantiates it via TYPE ARGUMENTS;
- **construction consumers**: the direct-`new` brand (or the permissive manual-constructor
  form) rides inside that same construct signature — the mirror of the emitted `$base_base`;
- **qualified bases**: the base expression clone pins every qualifier step onto its own
  source token (ranges resolved through `.original` — the layered clone drops positions);
- **source base type arguments** (`extends Base<T>`): pinned deep clones ride as heritage
  type arguments feeding INERT CARRIER type parameters appended to the signature (carriers
  first, consumer params after — argument order must mirror it), so hover/rename inside the
  `<...>` region resolves in CLASS scope exactly as written.

Positioning sharp edges (each has a suite guard; violating any one breaks silently
elsewhere):
- **no zero-width real range anywhere the checker reads** — `nodeIsMissing` (pos === end,
  pos >= 0) silently drops the node: a zero-width construct signature or heritage type
  argument degrades the whole cast to `any` (members vanish; `tsserver-diagnostics` and the
  fixture `@ts-expect-error` directives catch it). Width-1 anchors at the heritage END are
  the substitute (`referenceAnchor`).
- **no identifier-bearing gap in any getChildren scan** — the cast is stamped UNIFORMLY over
  the heritage span (identical ranges cannot gap; `source-view-trivia` catches offenders,
  incl. NodeArrays the synthetic-descendant pass skips).
- **tsserver prefers the identifier ENDING at the cursor** (`getTouchingToken` at-end
  preference) — no generated identifier may END exactly where a queried token STARTS
  (`stress-quickinfo` highlight-exactness catches it).
- the `as unknown as <cast>` chain is narrowed to the base token span so position lookups
  never descend into the cast.

**Superseded original fix (kept for context):** the fast path used to be gated to well-typed,
NON-generic, non-construction consumers extending a plain identifier base, with the navigable
base identifier STRETCHED over the whole heritage span (`Base<...>`) — the stretch produced
fat reference/rename spans over the type-argument tail, which the tightened `stress-references`
span checks would now reject.

Why it was a gap: a class's `extends Base` is genuinely rewritten to `extends X$base` in source
view, with the `$base` reference pinned onto the source `Base` position — so no node there carries
the real `Base` symbol. `.original` cannot rescue it: go-to-def takes its target strictly from
`getSymbolAtLocation(node).declarations` (`getDefinitionAtPosition` in `services.ts`), never from
`.original`, and the navigated identifier's text is `$base`. The obstruction is that the
class-extends chain does double duty: it carries C3-linearized override precedence /
generic-threaded members **and** occupies the source base position with the synthetic `$base` name.

**The fix (non-generic, non-construction):** `navigableConsumerBaseClassHeritage` (gated in
`expandConsumerClass`) skips `$base` and re-extends the **real** base under a single-source cast —
`extends (Base as unknown as AnyConstructor<Base & …mixins> & Omit<typeof Base,"prototype"|"new">
& …)` — pinning the real `Base` identifier onto its source position. Two subtleties, both with
sharp failure modes:
- The cast is *single source*: its **sole** construct signature carries the base **and** every
  mixin instance (so `super.<mixinMember>`, `implements`, `override` keep resolving); statics are
  `Omit<…,"prototype"|"new">` property bags with **no** construct signature. A competing construct
  signature (e.g. a bare `typeof Base`) wins the instance type and strands the mixin members →
  TS2720/TS4112.
- The cast's synthetic type nodes are left **synthetic** (negative positions). Collapsing them
  onto source text makes the checker re-read the `Omit<…,"prototype"|"new">` string literals from
  the source and blank them to `Omit<…, >`, degrading the cast to `any` so the base loses its
  members — manifests in the tsserver / `getSourceFile` path but **not** in a plain `tsc`
  program build. Only the navigable base identifier is stretched over the source heritage span (to
  claim the `<…>` tail and avoid stranding, #5).

**Residual gap** — these keep `$base`, so their base name still resolves to `$base`. Both are
DELIBERATE (removed from TODO — no further movement planned): the first has no source token to
navigate from at all, the second is broken code where `$base` is the diagnostics carrier — the
user fixes the diagnostics (or navigates from the base class's own declaration).
- classes with NO explicit extends clause (implicit required base / empty base) — no source
  token exists, so there is nothing to navigate from;
- classes **with diagnosed heritage** (unsatisfied required base, static collisions, missing
  runtime values, a mixin extending a mixin, a dependency-linearization conflict) — only on
  broken code; `$base` positions those diagnostics (`type-errors.ts` heritage sites are the
  tolerated empties in `stress-references`; every other class-extends site — mixins included —
  must now resolve, `inClassExtends`).

Superseded residual entry (closed, kept for context): a `@mixin` class's OWN heritage used to
keep the pair unconditionally — the `extends RequiredBase` span was overwritten by the
generated `__X$base` reference, so navigation dead-ended there even on well-typed mixins.

Superseded residual list (all three closed by the navigable fast path above, kept for
context): generic consumers (the `$base`-interface reasoning predated the generic-construct-
signature exit), construction-base consumers, qualified bases (the shallow-clone `[-1, -1]`
reasoning — the REAL root was `factory.cloneNode` SHARING children with the parse tree, which
the `$base` class's subtree collapse then mutated; `consumerBaseClassHeritage` now deep-clones).

Compiler reports heritage base-name errors at the *real* name, so emit is the correct path here.
Guard: `tsserver-base-navigation.t.ts` "navigation on a base type in an extends clause reaches the base
class". `stress-references` tolerates the residual empties; every *other* empty fails.

### Downstream-consumer contract coverage (emit under-reports)

A `@mixin` not satisfying its `implements` contract is now flagged by **both** paths on the mixin
*declaration* (same TS2420; see "Emit-path implements conformance"). What still differs: a
*consumer* using the mixin where the contract is expected sees the value's type — the generated
`interface X` that *inherited* the contract members — so emit reports nothing at the use-site while
source view flags it (TS2741). **Not** a `tsc`-green hole: the body is checked at the declaration,
so a violation never compiles either way; the editor merely flags the use sites in addition. The
parity sweep tolerates these source-view-only lines (`ideOnlyCoverageGaps`) — it only fails on
emit-only lines. Closing it needs the value-cast instance type to be the real body type, not the
inherited interface. Full breakdown: `stress-diagnostic-parity.t.ts` header (difference 1).

### Resolved

- **Generic mixin forwarding its type parameter into a generic required base** — `@mixin() class
  M<T> extends Base<T>` used to fail in both paths: emit → `TS2304 Cannot find name 'T'`, source
  view → `TS2562 Base class expressions cannot reference class type parameters`. Both came from the
  forwarded `T` inside the `RuntimeMixinClass<Base<T>>` marker (`createRuntimeMixinClassType`) — a
  top-level value-cast intersection with no enclosing generic scope (emit) and a `$base` base-class
  *expression* (source view). The marker only carries `[base]`; the required base is enforced
  elsewhere (the generated `interface … extends Base`, the `mix` signature's `<T, Base extends
  AnyConstructor<RequiredBase<T>>>`, and consumer-diagnostics). Fix:
  `eraseOwnTypeParameterReferences` rewrites the mixin's own type-parameter references inside that
  marker to `any` (`RuntimeMixinClass<Base<any>>`), well-formed in both paths; non-forwarded
  arguments (`Base<string>`) keep their precision. Guard: `generic-mixin-type-params.t.ts` (both
  builds succeed); that the erasure did not loosen enforcement is pinned through the PUBLISHED
  `.mix` signature in `declaration-fixture-suite/src/package-manual-mix-generic.t.ts` — the
  program-local `.mix(Unrelated)` probe it used to live on is banned now (TS990012).

- **A `@mixin` whose OWN dependencies cannot be C3-linearized** (a conflict with no consumer to
  force the merge, e.g. a 3-cycle) used to compile cleanly — only the runtime threw when the mixin
  was defined. Now reported at compile time in **both** paths, via **two carriers** because emit has
  no `__X$base`: source view puts a never-constrained validation type parameter on the generated
  `__X$base` and instantiates it with the message in the position-preserved heritage clause
  (`createLinearizationDiagnosticValidation` + `appendSourceViewValidationTypeParameters` — the same
  stress-safe mechanism a *consumer's* linearization conflict uses, so it does NOT strand); emit
  intersects `MixinLinearizationConflict<"<message>">` into the value cast
  (`withMixinLinearizationConflictType`), the `"<message>"` literal pinned to the first `implements`
  type so the remap lands on the heritage line. **Invariant:** a standalone diagnostic alias for
  this (anchored on any real token, or even a generated gap range) strands in the source view; route
  it through the off-screen `__X$base` instead. **Corpus consequence:** a conflicting `@mixin` cannot
  live in the build-must-pass `tests/fixture-suite/src` — its emit-mode error cannot be suppressed
  with `@ts-expect-error` (the `@mixin` decorator is stripped and the file reprinted, displacing the
  directive relative to the generated value statement). A consumer-only conflict (a plain class
  implementing two individually-consistent mixins) suppresses cleanly because consumers have no
  decorator. Guards: `diamond-linearization.t.ts` (both `--noEmit` and emit),
  `source-transform-cross-package-linearization.t.ts`.

## Debugging

### Scripts (`scripts/`)

Before a throwaway script, use the reusable ones (compiled to `dist/scripts/`, full usage in
`scripts/README.md`). Input is `--file <path>` / positional path / `--code "<snippet>"` / stdin (a
snippet must import `mixin`/`Base` from the package). `--mode emit|ide|both` selects emit vs
source-view.

- `print-transformed.js [--mode emit|ide|both]` — emitted code for a file/snippet.
- `print-ast.js [--mode ide|emit]` — AST tree with `[pos,end]`, flagging `⚠ NEGATIVE` /
  `⚠ ZERO-WIDTH` ranges and each class/interface `<members[]>` range (the bugs behind #2/#4/#5).
- `program-diagnostics.js [--file <substr>] [--mode emit|ide] [--print] [--types <prop>]` — real
  cross-file ProgramTransformer over a tsconfig (default fixture-suite), printing semantic
  diagnostics and (with `--types new`) the resolved type/return of every `.new`. The only one that
  exercises the cross-file registry; prefer it for "what does the IDE see" (`--mode ide`).
- `find-trivia-crashes.js [--file <substr>] [--tsconfig <path>]` — enumerate every "Identifier in
  trivia" crash site (#5/#8) across a suite in one in-process source-view pass, with each node's
  kind/range and the stranded identifier text/offset (which points at the mis-ranging generation
  site). `source-view-trivia.t.ts` asserts this count is zero; this gives the per-site detail.

### Reproduction tricks

**Checker diagnostics in a plain Node process.** Spoof tsserver detection before importing the
ts-patch-patched typescript, then build a program over the fixture suite — the plugin auto-applies
in source-view mode (`resolveUsePrintedSourceFile` checks `process.argv`):

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

From there inspect the transformed AST, binder state (`node.symbol`, `node.locals`,
`symbol.members`) and checker resolution. Caveat: `tests/fixture-suite/src/type-errors.ts` is
intentionally broken — exclude it in emit mode.

**This trick only reproduces *checker* diagnostics.** The #4/#5/#6/#9 crashes fire in tsserver
*services* (`getTokenAtPosition` / `getChildren` / `createSyntaxList` / quickinfo) which the plain
program API never exercises. For those, drive a real tsserver session (the `tsserver-*.t.ts` tests
do) or `LanguageService.getQuickInfoAtPosition` over a fixture; the cheapest single-fixture
reproduction is a real cross-file build (write files to a temp dir with the plugin tsconfig and run
the patched `tsc -p …` — exactly what `createTypeScriptFixture` + the `*-build-and-runtime.t.ts`
tests do; prefer adding a fixture test over a throwaway script).

**Inspect generated ranges without tsserver** — most failures are a wrong `pos`/`end`. Call the
transform directly in source-view mode and walk the result:

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

`transformSourceFile` is single-file (no registry), so cross-file resolution (imported mixins,
cross-file construction bases) is *not* exercised — for those, drive a real multi-file build.

---

# Repository workflow

General conventions for working in this repo (package-internal architecture is documented
above; this section is the repo-level workflow).

## TypeScript

Source that lands in version control is TypeScript. Use JavaScript only where you must, and for
throw-away scripts.

## Linter / stylistic issues

Don't fix stylistic issues (ESLint warnings, including `@stylistic` and alignment rules) by hand
one by one. Run `pnpm run lint:fix` and let it format. Remaining warnings after that can be
ignored. Lint is formatting-only — run `lint:fix` BEFORE the build/test pass, never re-run tests
just because of a lint change.

## Comments

Comments are written in English.

## Build artefacts

Treat `/dist` and other build output as disposable — remove and re-create freely. Once
`pnpm run build` completes cleanly, assume the sources are correctly in `/dist`; don't manually
verify individual files landed.

## Dependencies

Add dependencies with `pnpm` and always pin an exact version, not a range. Shared versions
(`typescript`, `ts-patch`, `@bryntum/siesta`, `@types/node`) live in the `catalog:` of
`pnpm-workspace.yaml`.

## .gitignore

Prefer exact repo-root-anchored paths (`/dist`, not `dist`) so only the intended directory is
matched.

## @bryntum/siesta tests

For internal launches add `--no-color`. Siesta tests are plain Node executables — to run one,
launch its compiled file directly: `node dist/tests/<name>.t.js`.

## Writing changesets

A changeset (a file in `.changeset/`, consumed by `pnpm run bump`) is a **user-facing release
note**, not a development log. Two rules:

1. **If the change is internal plumbing, do NOT write a changeset at all.** Refactors, test
   coverage, renames, new fixtures, benchmark tweaks, doc edits — anything that leaves the
   package's observable behavior identical. A change earns a changeset only when it **fixes a
   bug, changes behavior, or changes the spec** the user relies on.
2. **If it IS user-facing, write it briefly, in the user's language.** One or two sentences:
   what now works, what is now rejected, what error they will see. Drop the internals — no
   generated-symbol names, no function/module names, no description of *how* it works inside.
   Keep what the user actually types or sees: public API, compiler options, and TypeScript
   diagnostic codes. Match the length and tone of the existing entries in `CHANGELOG.md`.

Example — good: "A `@mixin` may now declare its own constructor; it runs during construction."
Bad (internal, no changeset): "Refactored scope indexing into `classScopesByName`."
