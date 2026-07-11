---
"ts-mixin-class": patch
---

Construction/collision edge hardening, driven by new coverage:

- An EMPTY construction config is now EXACT: `.new()` / `.new({})` stay legal, but an
  unknown key is a type error (the empty shape is `Partial<Record<PropertyKey, never>>` —
  the previous `Partial<Pick<X, never>>` reduced to `{}` and accepted every object).
- An ABSTRACT construction class has no callable `.new`: the factory is not generated on
  an `abstract` class, and the inherited `Base.new` now requires a concrete constructor
  through its `this` parameter (TS2684 on an abstract static side). A concrete subclass
  gets its own typed factory with the full accumulated config, as before.
- Incompatible same-named instance members of combined mixins are now diagnosed in the
  IDE view too (they already failed a build that runs the transformer): a linear,
  facts-gated check inspects the whole combined intersection for `never`-collapsed keys
  and reports a friendly message on the offending `implements` entry — including
  conflicts only a three-plus mixin combination exhibits, which pairwise comparison
  cannot see.
- For a shared config key, the NEAREST declaration in the linearization now chooses the
  key's write type (a nearest field narrows to its field type; a nearest setter keeps its
  wider parameter type); requiredness stays monotonic regardless of order.
- Static-member collisions now normalize equivalent JavaScript property-key spellings:
  `static foo` collides with `static ["foo"]`, and `static 0` with `static "0"`.
- A published (`.d.ts`) construction contributor's config now reaches downstream
  consumers/subclasses IN FULL: numeric-literal keys are recovered, and the contributor's
  WHOLE published config type is additionally intersected in as a value-route part
  (`NonNullable<Parameters<(typeof V)["new"]>[0]>` — no generated imports, default
  exports included). The respellable keys it duplicates intersect to the same types; its
  unique cargo is what the fact transport cannot respell in another file — computed
  const-string / unique-symbol keys and index signatures. A required published parameter
  keeps the downstream `.new` parameter required. Same-program cross-file contributors
  intentionally keep the respelled-facts transport; generic uses are skipped.
- A subclass of a DEFAULT-exported `.d.ts` construction base is construction-enabled
  (the registry now resolves the `"default"` import binding for bases, like it always
  did for mixins).
- Fixed a latent emit-printer bug: numeric literals inside the flattened config alias's
  cloned intersection could print as source-position garbage and break the emitted
  output once multi-part configs carried numeric keys.
