# ts-mixin-class — internals guide for agents

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
   **Other collapse sites (not `$base` class-likes):** (a) **`.mix` apply type**
   (`createSourceViewMixinApplyType`) — a pure-typing scaffold from `deepCloneNode`d source
   members carries their real positions; collapse with `collapseSubtreeTextRange(node, {pos:-1,
   end:-1})` at its generation site, but note collapse only works at *statement* granularity
   (`preserveTopLevelStatementRanges` re-expands a `[-1,-1]` node nested in a positioned subtree
   → re-strands), and `[-1,-1]` is *missing* (→ `any`, #2), so a *type* that must still resolve
   needs a **tight positive** width-1 range via `generatedTextRange`. (b) **Generic construction
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

4. **Config-field optionality comes from the `?` token, not the initializer.** `public x: T = v`
   is a **required** config field; only `public x?: T` is optional. An initializer alone does not
   make it optional. Only `public` members enter the config.

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
`createMixinFactoryExpression` builds the body as `return class extends base implements
Contract1, … {…}` (`mixinFactoryHeritageClauses` clones the mixin's own `implements` types onto
the class expression). An `implements` clause is **type-only — erased in JS**, so runtime output
is byte-identical, but it makes the checker verify the *real* body against each contract. `base` is
typed `AnyConstructor<RequiredBase & deps>`, so members inherited from the required base / deps are
satisfied through `extends base`. This works **uniformly for generic and non-generic mixins** — the
type parameters are in scope inside the factory (`function <T>(base) { return class … implements
Container<T> }`), which the earlier `interface extends` / top-level-alias forms could not express.
**Position:** TS2420 on an anonymous class expression is reported at its `class` keyword (a
generated position); the class expression's range is pinned to the mixin's source name
(`preserveTextRange(…, declaration.name)`) so emit reports the **same TS2420 at the same line and
column** as the IDE. Guards: `emit-contract-conformance.t.ts` (non-generic missing, generic
missing, satisfied → no false positive) and the corpus parity sweep (33 seeds). The remaining
downstream-*consumer* propagation is still open — see Current gaps.

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
| `Could not determine parsed source file` / `Unsupported base class expression`, only in tsserver while typing | the transform threw on a transient incomplete-syntax node (#7). |
| a diagnostic appears on **unrelated** code after an edit and persists until server restart | the transform threw mid-edit; tsserver serves the untransformed fallback for the whole project (#7). |
| TS2304 in **emit** *and* TS2562 in **source view**, on a `@mixin` that `extends` a generic base | the mixin's own type parameter leaked into the `RuntimeMixinClass<Base<T>>` marker — must be erased to `any`; see `eraseOwnTypeParameterReferences` (Current gaps → Resolved). |
| TS2720 / TS4112 on a consumer extending a navigable-base cast | the single-source cast had a competing construct signature (a bare `typeof Base`), stranding the mixin members; statics must be `Omit<…,"prototype"|"new">` bags (Current gaps → heritage navigation). |

## Current gaps

### Heritage-clause navigation (partially closed)

go-to-def / find-all-references / quickinfo on a base type name *inside* a rewritten `extends` /
`implements` clause **reaches the real base for a well-typed, non-generic, non-construction
consumer**, and still resolves to the internal `$base` otherwise.

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

**Residual gap** — these keep `$base`, so their base name still resolves to `$base`:
- **generic** consumers — instance members must thread `T`, which can only live on a generic base
  the consumer extends (the `$base` interface); merging onto `interface Consumer<T>` instead makes
  `super.<mixinMember>` miss them (members land on `this`, not the base), and putting `Base<T>` in
  the consumer's own base expression trips TS2562;
- **construction-base** consumers — generated construction members + synthetic
  `super.initialize(...)` are wired against `$base`;
- **qualified bases** (`extends ns.Base`) — a shallow clone of the property-access leaves its
  inner `Base` at `[-1, -1]`, so navigation cannot land on it; gated out by an
  `isIdentifier(extendsType.expression)` check;
- consumers **emitting diagnostic validations** (unsatisfied required base, static collisions,
  missing runtime values) — only on broken code; `$base` positions those diagnostics.

Compiler reports heritage base-name errors at the *real* name, so emit is the correct path here.
Guard: `tsserver-references.t.ts` "navigation on a base type in an extends clause reaches the base
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
  arguments (`Base<string>`) keep their precision. Guard: `generic-mixin-required-base.t.ts` (both
  builds succeed; `.mix(Unrelated)` onto an unsatisfied base is still rejected with TS2345 in both
  paths — the erasure did not loosen enforcement).

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
