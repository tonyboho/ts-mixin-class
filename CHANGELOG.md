# ts-mixin-class

## 0.0.5 - 2026-06-20

### Patch Changes

- a3d64e9: Fix the IDE showing **no errors at all** in a mixin file when the tsconfig has `"declaration": true`. A generated `static new` made the editor's diagnostics crash, so it silently dropped every error while `tsc` still reported the real ones.
- e420562: Fix `tsc` reporting a mixin file's type errors on the **wrong line**. The emit step rewrites the file and shifts line numbers; errors are now mapped back to their real source position, so `tsc`, CI and the editor agree.
- a1fe63c: Make `tsc` flag a `@mixin` class that doesn't satisfy the interface it `implements`, matching the editor. A missing or mismatched member used to stay green under `tsc`/CI while the editor showed it red.
- ba0b58b: Let a generic `@mixin` class forward its own type parameter into a generic base (`@mixin() class M<T> extends Base<T>`), which previously failed to compile in both `tsc` and the editor. A concrete argument (`extends Base<string>`) already worked.
- 1cfac9a: Make the base name navigable in a consumer's `extends` clause. Go-to-definition, find-all-references and quickinfo on `Base` in `class Consumer extends Base implements Mixin` now reach the real `class Base` instead of an internal helper (common non-generic case).

## 0.0.4 - 2026-06-18

### Patch Changes

- f16e682: Fix the editor transform throwing while you type a half-finished `@mixin class X extends `. The crash took down the whole language server, so unrelated construction-base classes lost their generated `static new` until a restart.
- 569cea8: Fix an editor crash (quickinfo/rename) in a file that applies a mixin by hand with `Mixin.mix(Base)`.
- 0dcbf00: Fix an editor crash (quickinfo/rename) on a `@mixin` class name when the class had a decorator and/or type parameters.
- 007e915: Fix an editor crash (go-to-definition/rename) on a construction-base mixin's `Mixin.new(...)`.
- 040bf9e: Fix an editor crash navigating a generic construction-base mixin or consumer.
- d36daf6: Fix editor crashes navigating an `implements`-only mixin consumer; it now keeps its real `implements` clause, matching `tsc`.
- ba5bd30: Fix editor navigation on a consumer class's own name (clicking it did nothing) and quickinfo on a later type parameter wrongly resolving to the first one.
- ef94ba7: Fix a remaining editor crash on a consumer whose mixins can't be ordered (a C3 conflict).
- 1a0c13e: Fix many editor crashes (go-to-definition/rename/quickinfo) across mixin symbols — generic type parameters, mixin base classes, and implements-only consumer constructors.
- 22d3655: Fix two editor hover-highlight glitches: a consumer's type-parameter hover covering the whole `<T, A>` list, and a mixin's `extends Base` hover spanning the entire clause.
- 1a37c05: Collect a construction-base mixin's `new` config from its full mixin chain, so `Mixin.new({ deepProp })` no longer rejects a property mixed in indirectly.
- 8dc3b8a: Fix `Mixin.new()` on a standalone construction-base mixin returning `Base` instead of the mixin's own type. Also removed the `instance-type` construction config mode (and the `constructionConfig` option); public-only config is now the only behavior.

## 0.0.3 - 2026-06-16

### Patch Changes

- Set up the publishing process (Changesets, shared ESLint config, pre-release gate) and internal cleanup.
