# ts-mixin-class

## 0.0.10 - 2026-07-07

### Patch Changes

- 9f109b5: Base-name navigation in a consumer's `extends` clause now works for every
  consumer — generic, `Base`-construction and qualified (`extends ns.Base`) — including
  inside the base's `<...>` type arguments (go-to-definition, references, rename,
  quickinfo).
- e494841: Base-name navigation now also works on a `@mixin` class's own `extends` clause
  (`@mixin class Tagged extends RequiredBase`), generic mixins included — completing
  base-name navigation for every well-typed heritage clause with an explicit base.
- b1f9bf6: Qualified bases are now full construction bases. A consumer extending through a
  local namespace (`extends data.Model`), a namespace import (`extends lib.Widget`), or a
  chain over an imported intermediate base gets the generated `static new` and
  `<Name>Config` with the whole chain's config keys — cross-file subclassing included.
  Chains also survive a module that imports nothing from the package itself.
- 2e2088a: **Source map support.** A build that runs the transformer used to emit broken
  maps — positions below the first generated insertion drifted, so breakpoints and stack
  traces lied. Emitted maps now compose back to the real source, and a file the transform
  leaves untouched emits byte-identical to a plugin-less build. Covers `sourceMap`,
  `inlineSourceMap`, `inlineSources` and `declarationMap`.

## 0.0.9 - 2026-07-06

### Patch Changes

- Point package metadata at the standalone repository.

## 0.0.8 - 2026-07-03

### Patch Changes

- 6cfe4a9: Support **qualified mixin references** — a consumer can reference a mixin
  through a namespace import (`implements lib.Logger`) or a local namespace
  (`implements NS.Tagger`). Such a consumer used to be left untransformed and failed with
  a bare TS2420. A consumer that applies a qualified mixin declared **above** its own
  `namespace` block is now rejected with a clear diagnostic instead of emitting code that
  crashes at runtime.
- 004a456: Construction classes are now built **only** through their generated
  `.new(...)`; a direct `new X()` is a compile-time error (it silently bypassed
  `initialize()` before). A `@mixin` may now declare its own constructor — it is preserved
  and runs during construction.
- 5c913f9: Fix a mixin's own **parameter properties**
  (`constructor(public label: string = …)`) missing from the type under `tsc` — the value
  existed at runtime but the consumer saw a TS2339. They now appear as members, with
  `readonly` preserved.
- f3e0ade: Reject an **instantiated namespace merged with a `@mixin` class** (the
  static-helper pattern) with a clear diagnostic (TS990009) — the merge silently lost the
  namespace's members. A type-only namespace merge stays legal.
- 05aae8c: A mixin's **accessors now keep real `get`/`set` types** on consumers — a split
  get/set pair keeps its distinct read and write types instead of collapsing to one
  property. New diagnostic **TS990010**: a class field shadowing a mixin's accessor (or
  the reverse) in a way that would misbehave at runtime is rejected under
  `useDefineForClassFields`.
- 1d4f91f: **Auto-accessors** (`accessor x: T`) on a mixin are handled as real accessors
  on consumers, and **variance annotations** (`in`/`out`) on a generic mixin's type
  parameters no longer break the build.
- eef7179: Work around a TypeScript 6.0 crash when a mixin declares a **`this`-typed
  accessor** (`get self(): this`); consumers narrow it the same way.
- f6b0703: Fixes — a mixin or consumer declared in a **`switch` case/`default` clause** was
  silently not expanded, and the editor **offered internal helper names** in completions.
  New diagnostic **TS990008**: a class applying a local mixin declared **later in the same
  scope** (which would crash at runtime) is flagged on both `tsc` and the editor.
- dc007ad: Checker error messages that embed a base-class name now show **your** class
  names instead of internal generated names, on both `tsc` and the editor (the override
  family TS4113/TS4114/TS4117, member-compat TS2416/TS2417). The generated `.new`'s name
  and the `<Class>Config` alias also render correctly in editor hovers and signature help.
- bd0ab09: Fix a tsserver crash (`Debug Failure`) on every edit in a package using
  `moduleResolution` `node16`/`nodenext`, which made the editor **silently show no errors
  at all**.
- 8b6c847: A **generic construction-base mixin**
  (`@mixin() class Stash<T> extends Base`) now has the full construction surface — a typed
  `.new<T>` and `<Mixin>Config<T>` — instead of falling back to an untyped base.
  `static mix` on a `@mixin` is now a reserved name (it is the framework's application
  method); `static new` is not reserved, and a user's own `static new` overrides the
  generated one.
- a593eb1: Support **`isolatedDeclarations: true`** on the `tsc` layer — a program using
  the transformer builds cleanly under the option. Adds the public type `Mix<M, B>` for
  annotating a manual `M.mix(B)` in an external consumer.
- 1c1e072: Fix a plain nested class whose name **collides with a `@mixin` in a sibling
  scope** making a neighbouring consumer expand against the wrong class — it failed to
  build and crashed at runtime. Such a consumer is now left as ordinary TypeScript.
- 13dd85f: Reject a **manual `.mix(...)` on a mixin declared in your own program** with a
  clear diagnostic (TS990012) naming the `implements` fix — inside a transformer project
  mixins compose through the class heritage. `.mix` remains supported for external
  consumers of the published declarations.
- 2646f38: Fix **user decorators on a `@mixin` class** being silently dropped from the
  build output (both decorator modes).
- 32c28f3: A mixin's **member decorators** now work in legacy `experimentalDecorators`
  mode too.
- d5f04a4: A mixin's own `static` body can now reach its base's and dependencies' statics
  through **`super`** on the `tsc` build (including `super.new(...)`), matching the editor;
  an incompatible static override is now a build error (TS2417) instead of passing
  silently.
- cabad6d: The transformer's structural errors are now real TypeScript diagnostics with
  **stable codes (TS990001–TS990007)** and precise spans, instead of a generic TS2344.
  Because they run after type-checking, they can no longer be silenced with
  `@ts-expect-error`.
- 77f8ab3: A `@mixin` or a mixin consumer may now be declared **anywhere a class
  declaration is legal** — inside a function body or block, not just at the top level — on
  both `tsc` and the editor. Class expressions remain unsupported but now get a clear
  diagnostic instead of a bare TS2420.
- e885d94: Spec — **`noImplicitOverride` extends to mixin-member overrides**: an unmarked
  override is TS4114 and you mark it `override` as with a real base; the `override`
  modifier is also accepted in the default config.
- 2ec4e84: New diagnostic **TS990011**: an accessor override that declares fewer halves
  than it overrides (e.g. get-only over a get/set pair) silently kills the missing half at
  runtime — this narrowing is now rejected on mixin layers. Extending (adding halves)
  stays legal.
- 503616b: A **`static {}` block on a `@mixin` class** is now supported (previously
  rejected with TS990004); it runs once per base the mixin is applied over.

## 0.0.7 - 2026-06-27

### Patch Changes

- 3399077: Always name the `<Class>Config` alias in `<Class>.new({ ... })` errors. When a
  config mixed required and optional fields, a call missing a required key reported
  `... but required in type 'Pick<Class, ...>'` instead of naming the alias; the generated
  `<Class>Config` name is now used throughout the message, including the nested "but
  required in type ..." line. Quickinfo on such a config also resolves to its field shape
  (`{ id: string; label?: string }`) rather than an opaque `Pick<...> & Partial<...>`.
  Configs that are entirely required or entirely optional are unchanged.
- e1e2b6e: Name the generated `<Class>Config` alias in the editor. A failing
  `<Class>.new({ ... })`, or any reference to the config type, used to show a meaningless
  `}` where the alias name belongs; the IDE now reads the real `<Class>Config` name in
  diagnostics, hovers, and quickinfo — generics included.

  This adds a companion language-service plugin. Register it next to the program transform
  in `tsconfig.json` so editor navigation (go-to-definition, find-references, rename) stays
  clean for the generated aliases:

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
  initializer is given an explicit default in the emitted code, so each instance keeps a
  stable object shape (monomorphic property access in V8). The fill uses a non-null
  assertion (`undefined!` / `null!`), so the field's declared type is never widened.

  Three modes: `"undefined"` (default), `"null"`, and `"nothing"` (off). The fill applies
  to fields of every visibility — public, protected, private, or unmarked — and only where
  no initializer was written: a field with an explicit initializer is left untouched, so
  `public id: number = undefined` stays a type error.

- 937d5f7: Mark a required construction-config key with the definite-assignment `!`. A
  public field declared `id!: T` is a required key in the generated `<Class>Config`; every
  other public field is optional. The `!` reads as "supplied from outside" — exactly what
  `.new({ ... })` provides — and lets the field skip an initializer without a strict
  property-initialization error. A `!` field may still carry a default (`id!: T = ...`),
  even though TypeScript normally forbids `!` together with an initializer: the default is
  applied during construction while `.new({ ... })` still requires the key.

## 0.0.6 - 2026-06-26

### Patch Changes

- c72ad4f: Speed up `instanceof` checks on mixin classes.
- e6198fb: Precompute C3 linearization at compile time. The mixin order is now resolved
  once during compilation and emitted as a compact replay plan, so at runtime the
  inheritance chain is assembled by replaying that plan instead of running the full C3
  algorithm — removing the per-declaration linearization cost.

  Two compile-time flags (environment variables read by the compiler and baked into the
  emitted code) control the behavior:

  - `TS_MIXIN_VERIFY_LINEARIZATION` (on by default) — re-checks every replayed order
    against C3 at runtime and throws on a mismatch. Set it to `0` when building for
    production to drop the check.
  - `TS_MIXIN_DISABLE_LINEARIZATION_PLAN` — set it to `1` to emit code that ignores the
    plan and runs C3 at runtime instead, as an escape hatch.

  Mixin-only linearization conflicts (a `@mixin` class with inconsistent dependency order
  and no consumer) are now reported at compile time in both `tsc --noEmit` and emit mode.

## 0.0.5 - 2026-06-20

### Patch Changes

- a3d64e9: Fix the IDE showing **no errors at all** in a mixin file when the tsconfig has
  `"declaration": true`. A generated `static new` made the editor's diagnostics crash, so
  it silently dropped every error while `tsc` still reported the real ones.
- e420562: Fix `tsc` reporting a mixin file's type errors on the **wrong line**. The emit
  step rewrites the file and shifts line numbers; errors are now mapped back to their real
  source position, so `tsc`, CI and the editor agree.
- a1fe63c: Make `tsc` flag a `@mixin` class that doesn't satisfy the interface it
  `implements`, matching the editor. A missing or mismatched member used to stay green
  under `tsc`/CI while the editor showed it red.
- ba0b58b: Let a generic `@mixin` class forward its own type parameter into a generic base
  (`@mixin() class M<T> extends Base<T>`), which previously failed to compile in both `tsc`
  and the editor. A concrete argument (`extends Base<string>`) already worked.
- 1cfac9a: Make the base name navigable in a consumer's `extends` clause.
  Go-to-definition, find-all-references and quickinfo on `Base` in
  `class Consumer extends Base implements Mixin` now reach the real `class Base` instead of
  an internal helper (common non-generic case).

## 0.0.4 - 2026-06-18

### Patch Changes

- f16e682: Fix the editor transform throwing while you type a half-finished
  `@mixin class X extends `. The crash took down the whole language server, so unrelated
  construction-base classes lost their generated `static new` until a restart.
- 569cea8: Fix an editor crash (quickinfo/rename) in a file that applies a mixin by hand
  with `Mixin.mix(Base)`.
- 0dcbf00: Fix an editor crash (quickinfo/rename) on a `@mixin` class name when the class
  had a decorator and/or type parameters.
- 007e915: Fix an editor crash (go-to-definition/rename) on a construction-base mixin's
  `Mixin.new(...)`.
- 040bf9e: Fix an editor crash navigating a generic construction-base mixin or consumer.
- d36daf6: Fix editor crashes navigating an `implements`-only mixin consumer; it now keeps
  its real `implements` clause, matching `tsc`.
- ba5bd30: Fix editor navigation on a consumer class's own name (clicking it did nothing)
  and quickinfo on a later type parameter wrongly resolving to the first one.
- ef94ba7: Fix a remaining editor crash on a consumer whose mixins can't be ordered (a C3
  conflict).
- 1a0c13e: Fix many editor crashes (go-to-definition/rename/quickinfo) across mixin
  symbols — generic type parameters, mixin base classes, and implements-only consumer
  constructors.
- 22d3655: Fix two editor hover-highlight glitches: a consumer's type-parameter hover
  covering the whole `<T, A>` list, and a mixin's `extends Base` hover spanning the entire
  clause.
- 1a37c05: Collect a construction-base mixin's `new` config from its full mixin chain, so
  `Mixin.new({ deepProp })` no longer rejects a property mixed in indirectly.
- 8dc3b8a: Fix `Mixin.new()` on a standalone construction-base mixin returning `Base`
  instead of the mixin's own type. Also removed the `instance-type` construction config
  mode (and the `constructionConfig` option); public-only config is now the only behavior.

## 0.0.3 - 2026-06-16

### Patch Changes

- Set up the publishing process (Changesets, shared ESLint config, pre-release gate) and
  internal cleanup.
