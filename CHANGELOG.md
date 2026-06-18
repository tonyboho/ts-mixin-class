# ts-mixin-class

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
