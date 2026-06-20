# ts-mixin-class

## 0.0.5 - 2026-06-20

### Patch Changes

- a3d64e9: Fix the IDE showing **no errors at all** for a file with a mixin class when the project's tsconfig has `"declaration": true`. tsserver's semantic diagnostics also compute declaration diagnostics, which ran TypeScript's declaration-emit transform over the source-view tree and crashed (`isDeclarationAndNotVisible` reading `getParseTreeNode(node).kind` on `undefined`) on a fully-synthetic generated member — the construction `static new`, which carries no `.original`. The whole `semanticDiagnosticsSync` request then failed, so the editor received an error response and rendered no diagnostics while `tsc` still reported the real type errors. `alignGeneratedNavigableNodesWithParseTree` now also clears the `Synthesized` flag on generated members (the construction `static new` and generated property/accessor) that have no resolvable parse-tree node, so they resolve to themselves and declaration emit no longer crashes. The flag-clearing for navigable kinds (heritage references etc.) is unchanged, so find-all-references / rename on a base name are unaffected.
- e420562: Fix `tsc` reporting type errors on the **wrong line** for files containing a mixin class. The emit path reprints the transformed (value-cast) tree to text — mixin expansion adds and removes lines — so diagnostics landed on regenerated lines that do not exist in the source on disk, diverging from the IDE / `--noEmit` positions (a problem for CI logs and error navigation). The transformer now captures the printer's source map for each reprinted file and remaps every emit-path diagnostic (`getSyntactic`/`getSemantic`/`getDeclarationDiagnostics` and `emit`) back to its real source position, so `tsc` and the editor agree. The reprinted tree is still what gets emitted, so runtime output is unchanged.
- a1fe63c: Make `tsc` (emit) flag a `@mixin` class that does not satisfy the contract it
  `implements`, matching the IDE / `--noEmit`. The emit path lowers a mixin to a value
  cast `const X = defineMixinClass(...) as unknown as <type>`, whose `as unknown as`
  double-cast erased the structural check between the runtime mixin body and its
  `implements` contracts (and the generated `interface X extends Contract` _inherited_ the
  contract's members instead of checking the class against them) — so a missing or
  mismatched member stayed green under `tsc`/CI while the editor showed it red.

  The fix puts the mixin's `implements` clause back on the factory's inner runtime class
  (`return class extends base implements Contract {…}`). That clause is type-only (erased
  in JS, so runtime output is unchanged) but makes the checker verify the _real_ body
  against each contract. It works uniformly for generic and non-generic mixins (the mixin's
  type parameters are in scope inside the factory), and — pinned to the mixin's source name
  — emits the same TS2420 the IDE does, on the same source line and column.

- ba0b58b: Let a generic `@mixin` class forward its own type parameter into a generic required base
  (`@mixin() class M<T> extends Base<T>`). This previously failed to compile in both
  transform paths: emit reported `TS2304: Cannot find name 'T'` and source view reported
  `TS2562: Base class expressions cannot reference class type parameters`. A required base
  with a _concrete_ type argument (`extends Base<string>`) already worked.

  Both errors came from the single forwarded `T` inside the generated
  `RuntimeMixinClass<Base<T>>` marker, which lands in a position that cannot bind it — the
  top-level value-cast intersection (emit) and the `$base` base-class expression (source
  view). That marker only carries the `[base]` requirement type; the required base is still
  enforced by the generated `interface … extends Base`, the `mix` signature, and
  consumer-diagnostics. The fix erases references to the mixin's own type parameters inside
  that marker to `any`, keeping it well-formed in both paths while leaving non-forwarded
  arguments (`Base<string>`) precise. Mixing onto a base that does not satisfy the required
  base is still rejected in both paths.

- 1cfac9a: Make the base type name navigable in a consumer's `extends` clause for the common case.
  Go-to-definition, find-all-references and quickinfo on the base name in `class Consumer
extends Base implements Mixin` now reach the real `class Base` instead of the internal
  generated `$base`.

  In source view a consumer used to be rewritten to `extends Consumer$base`, with the
  generated `$base` reference pinned onto the source base position, so the base name resolved
  to the internal helper (empty references/definition, `any` quickinfo). For a well-typed,
  **non-generic, non-construction** consumer the transformer now skips that indirection and
  re-extends the real base under a single-source cast (`extends (Base as unknown as
AnyConstructor<Base & …mixins> & …statics)`), keeping the real base identifier on its source
  position while `super.<mixinMember>`, statics, `implements` and `override` all keep
  resolving. Generic consumers, construction-base consumers, and consumers whose code is in
  error keep the `$base` rewrite (their instance members / construction wiring / diagnostics
  genuinely need it), so navigation on their base name is unchanged.

## 0.0.4 - 2026-06-18

### Patch Changes

- f16e682: Fix the source-view transform throwing on a half-typed `@mixin class X extends ` while typing in the IDE. The throw crashed the whole tsserver program build, which fell back to the untransformed program — so unrelated construction-base classes lost their generated `static new` until a server restart.
- 569cea8: Fix a tsserver quickinfo/rename crash when navigating a file that applies a mixin manually via `Mixin.mix(Base)`. The `.mix` apply type stranded cloned member identifiers in a trivia gap; it is now collapsed to a synthetic range (it only shapes `typeof MixinClass`).
- 0dcbf00: Fix a source-view quickinfo/rename crash on a `@mixin` class name, where the generated `$base` range reached back over the `@mixin()` decorator and stranded its identifier. Decorated `$base` helpers now collapse to a synthetic range, and a generic `$base`'s type parameters span the source `<...>`.
- 007e915: Fix a tsserver crash on go-to-definition/rename for a construction-base mixin's `Mixin.new(...)` in source view. The synthetic `static new` mapped back to a clone the program never binds; it now skips `setOriginalNode` in source view.
- 040bf9e: Fix a tsserver crash navigating a generic construction-base mixin/consumer in source view. The generic `static new<T>` overload stranded its cloned type parameter `T`; the clones are now collapsed so they normalise into the method's range.
- d36daf6: Fix tsserver crashes navigating an `implements`-only mixin consumer in source view. The consumer now keeps its real `implements` clause (matching emit), and the generated `extends $base` plus any metadata-cast heritage use tight synthetic ranges instead of stretching over source.
- ba5bd30: Fix language-server navigation on a mixin consumer class's own name (clicking the class name did nothing) and quickinfo on a later type parameter resolving to the first. The internal `$base` helpers now collapse off-screen, so the real declaration owns its source positions.
- ef94ba7: Fix the last source-view trivia crash, on a consumer whose mixins fail C3 linearization. Its diagnostic `$base` declarations used the throwaway emit range and stranded the consumer name; they now route through the source-view range mapper like the normal path.
- 1a0c13e: Fix tsserver crashes on go-to-definition/rename/quickinfo for many source-view symbols (generic type parameters, mixin-heritage base classes, implements-only consumer constructors). Generated nodes whose `.original` escapes the bound tree now have the `Synthesized` flag cleared, so navigation stops following them into the unbound clone (`.original` stays for emit/diagnostics).
- 22d3655: Fix two source-view hover-span defects: a consumer's type-parameter highlight landing on the wrong parameter (the whole `<T, A>` list), and a mixin's `extends Base` highlight spanning the entire heritage clause. Each generated reference is now pinned to its own source identifier.
- 1a37c05: Collect a construction-base mixin's `new` config from its whole linearized mixin chain, not just direct `implements` refs, so `Mixin.new({ deepProp })` no longer rejects a transitively-mixed property.
- 8dc3b8a: Fix `Mixin.new()` on a standalone construction-base mixin resolving to `Base` instead of the mixin's own instance type. Also removed the `instance-type` construction config mode (and the `constructionConfig` option / `ConstructionConfigMode` type); public-only config is now the only behavior.

## 0.0.3 - 2026-06-16

### Patch Changes

- Set up the publishing process (Changesets, shared ESLint config, pre-release gate) and internal cleanup.
