# ts-mixin-class

## 0.0.7 - 2026-06-27

### Patch Changes

- 3399077: Always name the `<Class>Config` alias in `<Class>.new({ ... })` errors. When a
  config mixed required and optional fields, a call missing a required key reported
  `... but required in type 'Pick<Class, ...>'` instead of naming the alias; the
  generated `<Class>Config` name is now used throughout the message, including the
  nested "but required in type ..." line. Quickinfo on such a config also resolves
  to its field shape (`{ id: string; label?: string }`) rather than an opaque
  `Pick<...> & Partial<...>`. Configs that are entirely required or entirely
  optional are unchanged.
- e1e2b6e: Name the generated `<Class>Config` alias in the editor. A failing
  `<Class>.new({ ... })`, or any reference to the config type, used to show a
  meaningless `}` where the alias name belongs; the IDE now reads the real
  `<Class>Config` name in diagnostics, hovers, and quickinfo — generics included.

  This adds a companion language-service plugin. Register it next to the program
  transform in `tsconfig.json` so editor navigation (go-to-definition,
  find-references, rename) stays clean for the generated aliases:

  ```json
  {
    "compilerOptions": {
      "plugins": [
        { "transform": "ts-mixin-class", "transformProgram": true },
        { "name": "ts-mixin-class/language-service-plugin" }
      ]
    }
  }
  ```

  It is optional but recommended.

- 601cd69: Add the `fillMissedInitializersWith` compiler-plugin option. For classes that
  extend `Base` (directly or transitively), every instance field left without an
  initializer is given an explicit default in the emitted code, so each instance
  keeps a stable object shape (monomorphic property access in V8). The fill uses a
  non-null assertion (`undefined!` / `null!`), so the field's declared type is never
  widened.

  Three modes: `"undefined"` (default), `"null"`, and `"nothing"` (off). The fill
  applies to fields of every visibility — public, protected, private, or unmarked —
  and only where no initializer was written: a field with an explicit initializer is
  left untouched, so `public id: number = undefined` stays a type error.

- 937d5f7: Mark a required construction-config key with the definite-assignment `!`. A public
  field declared `id!: T` is a required key in the generated `<Class>Config`; every
  other public field is optional. The `!` reads as "supplied from outside" — exactly
  what `.new({ ... })` provides — and lets the field skip an initializer without a
  strict property-initialization error. A `!` field may still carry a default
  (`id!: T = ...`), even though TypeScript normally forbids `!` together with an
  initializer: the default is applied during construction while `.new({ ... })` still
  requires the key.

## 0.0.6 - 2026-06-26

### Patch Changes

- c72ad4f: Speed up `instanceof` checks on mixin classes.
- e6198fb: Precompute C3 linearization at compile time. The mixin order is now resolved once
  during compilation and emitted as a compact replay plan, so at runtime the inheritance
  chain is assembled by replaying that plan instead of running the full C3 algorithm —
  removing the per-declaration linearization cost.

  Two compile-time flags (environment variables read by the compiler and baked into the
  emitted code) control the behavior:

  - `TS_MIXIN_VERIFY_LINEARIZATION` (on by default) — re-checks every replayed order against
    C3 at runtime and throws on a mismatch. Set it to `0` when building for production to
    drop the check.
  - `TS_MIXIN_DISABLE_LINEARIZATION_PLAN` — set it to `1` to emit code that ignores the plan
    and runs C3 at runtime instead, as an escape hatch.

  Mixin-only linearization conflicts (a `@mixin` class with inconsistent dependency order
  and no consumer) are now reported at compile time in both `tsc --noEmit` and emit mode.

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
