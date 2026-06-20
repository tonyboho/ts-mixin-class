# Supported use cases & test coverage

A catalog of every scenario `ts-mixin-class` is meant to support, with the test(s)
that cover it. Kept as a checklist for future work: when a feature changes, find its
row here, confirm the listed tests still pin the behavior, and add a row for anything
new.

Status legend:

- ✅ covered — a test asserts this directly
- ⚠️ partial — covered only implicitly, in one mode, or as a side effect of another test
- ❌ gap — no test, or known-broken (see notes)
- ⏭️ deferred — a `xit`/skipped test records a spec point that is intentionally not
  supported yet. The committed suite stays **green**: a skipped test is how the spec says
  "this is to-do / unsupported", not a hanging failure.

A note on the workflow: a **RED** (deliberately-failing) test is valid **only during the
coverage-expansion stage**, while work is in progress and uncommitted — it pins a found gap.
Before committing, every red test is resolved one of two ways: **fix it** (→ ✅) or **defer
it** (→ `xit`, ⏭️). The committed suite is always green; it reflects the *current* state of
the spec, where deferred points are skipped, not failing. Never commit a hanging red test.

Path note: runtime fixtures live in `tests/fixture-suite/src/*.t.ts` (compiled by the
transformer, then run under siesta in both `standard` and `legacy`/`experimentalDecorators`
configs). Transform/diagnostic/IDE tests live directly in `tests/*.t.ts`.

---

## 1. Mixin declaration (`@mixin()`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 1.1 | Plain mixin: fields + methods + statics copied into a consumer | ✅ | `fixture-suite/src/mixin-statics.t.ts`, `consumer-inheritance.t.ts` |
| 1.2 | Mixin instantiated standalone (`new Named()`), `instanceof`, statics | ✅ | `mixin-statics.t.ts`, `consumer-imported-mixins.t.ts` |
| 1.3 | Mixin self-reference (creates instances of its own type in a method) | ✅ | `mixin-self-reference.t.ts` |
| 1.4 | Mixin depending on another mixin (`@mixin() X implements Y`) + `super` | ✅ | `mixin-self-reference.t.ts`, `source-transform-mixins.t.ts` |
| 1.5 | Default-exported mixin (`export default class …`) | ✅ | `default-mixin-consumer.t.ts` |
| 1.6 | Mixin with a plain `implements` contract (non-mixin interface) | ✅ | `consumer-imported-mixins.t.ts` (`ContractMixin`) |
| 1.7 | Metadata symbols (`factory`/`requirements`/`base`) exposed | ✅ | `mixin-self-reference.t.ts`, `required-base-local.t.ts` |
| 1.8 | Mixin contributing **accessors** (get-only → `readonly` property; get/set pair → writable), correct on the consumer at type level **and** runtime (getter computes, setter mutates, descriptor stays a real accessor) | ✅ | `mixin-accessors.t.ts` |
| 1.9 | **Empty** mixin (no members) as a marker — zero-member interface path (`zeroWidthRange`); brands consumers (incl. transitively via an empty dependent mixin) and instantiates standalone | ✅ | `empty-mixin.t.ts` |
| 1.10 | A mixin method with **multiple call signatures** (overloads): all overloads are copied into the consumer's interface and resolve per-call (`string→number`, `number→string`), through `super` and at the consumer call site | ✅ | `fixture-suite/src/mixin-overloaded-method.t.ts` |
| 1.11 | A mixin's **static accessor** (get/set pair), not just a static method/field: inherited onto the consumer's constructor; getter computes, setter mutates shared static state | ✅ | `fixture-suite/src/mixin-static-accessor.t.ts` |
| 1.12 | **Two-hop** mixin dependency (`Top⇒Mid⇒Bottom`): a consumer gets `Bottom`'s members transitively and the `super` chain threads all three in C3 order | ✅ | `fixture-suite/src/mixin-two-hop-dependency.t.ts` |

## 2. Consumers (`implements`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 2.1 | No-base consumer (`class C implements A, B`) | ✅ | `consumer-inheritance.t.ts` (`NoBaseConsumer`) |
| 2.2 | Consumer with an explicit (non-`Base`) base + `super` into mixins | ✅ | `consumer-inheritance.t.ts`, `consumer-imported-mixins.t.ts` |
| 2.3 | Consumer subclassed again (`class Sub extends Consumer`) | ✅ | `consumer-inheritance.t.ts` (`SubConsumer`) |
| 2.4 | Consumer with its own explicit constructor (no `Base`) | ✅ | `fixture-suite/src/consumer-constructor.t.ts` |
| 2.5 | Consumer base statics inherited | ✅ | `mixin-statics.t.ts`, `consumer-inheritance.t.ts` |

## 3. Linearization (C3)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 3.1 | C3 merge algorithm (diamond, dedup, empty, inconsistent) | ✅ | `c3-linearization.t.ts` |
| 3.2 | Runtime `super` order follows C3 across a diamond | ✅ | `mixin-self-reference.t.ts`, `source-transform-mixins.t.ts` |
| 3.3 | Inconsistent C3 requirements rejected with a diagnostic | ✅ | `type-errors.ts`, `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |

## 4. Required bases (`@mixin() M extends BaseClass`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 4.1 | Consumer extends the required base (or a descendant) | ✅ | `required-base-local.t.ts`, `consumer-imported-mixins.t.ts` |
| 4.2 | No-base consumer is built on the canonical required base | ✅ | `required-base-local.t.ts` (`DefaultConsumer`), `required-base-imported-no-base.t.ts` |
| 4.3 | Standalone required-base mixin built on its canonical base | ✅ | `required-base-local.t.ts` (`canonicalRequired`) |
| 4.4 | Generic required base, type parameter forwarded (`M<T> extends B<T>`) | ✅ | `generic-mixin-required-base.t.ts` |
| 4.5 | Required base mismatch (unrelated base) rejected | ✅ | `type-errors.ts`, `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 4.6 | Required base still enforced after generic-`T` erasure (`.mix(Unrelated)`) | ✅ | `generic-mixin-required-base.t.ts` |
| 4.7 | Required base enforced at **runtime** through the transformer-emitted `.mix` (unrelated base throws; related descendant applies) — distinct plane from the raw-helper guard in `runtime-helper.t.ts` | ✅ | `required-base-runtime-guard.t.ts` |

## 5. Manual application (`.mix(Base)`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 5.1 | `class X extends Mixin.mix(Base)` keeps base ctor, statics, `instanceof` | ✅ | `manual-mix.t.ts`, `source-transform-consumer-typecheck.t.ts` |
| 5.2 | Generic manual mix (`Mixin.mix<T, typeof Base>(Base)`) | ✅ | `manual-mix.t.ts`, `source-transform-consumer-typecheck.t.ts` |
| 5.3 | Generic mix requires the base type arg when mixin args are explicit | ✅ | `manual-mix.t.ts` (`@ts-expect-error`) |
| 5.4 | Manual `.mix(Base)` of a mixin that **depends** on another mixin (`Main implements Dep`): the dependency is applied transitively at runtime **and** reachable through the type (`Main`'s interface `extends Dep`) — **emit/runtime only** | ✅ | `manual-mix-dependency.t.ts` |
| 5.4-sv | The same `extends Main.mix(Base)` (dependent mixin) type-checks in **source-view** (IDE) as it does in emit | ✅ | `tsserver-diagnostics.t.ts` → "a manual .mix of a dependent mixin is clean in source-view" (regression guard). Fixed: the dependency's framework `mix` was shadowing the mixin's own in the source-view value cast — now `Omit<ClassStatics<typeof Dep>, "mix">`. See Resolved. |
| 5.5 | Manual `.mix(Base)` of a mixin with a **two-hop** dependency chain (`Top⇒Mid⇒Bottom`): `.mix` linearizes and applies both transitive dependencies; `super` threads all three; the instance type reaches `Bottom`'s members through two interface-extends hops; `instanceof` matches every layer | ✅ | `fixture-suite/src/manual-mix-two-hop-dependency.t.ts` |

## 6. Generics

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 6.1 | Generic mixin, generic consumer, generic `super`, instance type | ✅ | `consumer-constructor.t.ts`, `mixin-self-reference.t.ts` |
| 6.2 | Generic mixin statics | ✅ | `mixin-statics.t.ts` |
| 6.3 | Generic type arguments preserved through imported mixins | ✅ | `consumer-imported-mixins.t.ts`, `type-only-imported-mixin.t.ts` |
| 6.4 | **Multiple** type parameters and a **constraint** (`K extends string`) on a mixin, fixed by a consumer and forwarded (constrained) through a consumer | ✅ | `generic-mixin-variations.t.ts` |
| 6.5 | **Defaulted** type parameter on a mixin (`<V = number>`) compiles in emit + source-view | ✅ | `generic-mixin-defaulted-type-param.t.ts`. Fixed: the generated `.mix`'s synthetic `__MixinBase` now carries a default (equal to its constraint) when the mixin has a defaulted own param, so it is no longer a required-after-optional parameter (TS2706). See Resolved. |

## 7. Instantiation / construction (`extends Base`, static `.new`)

Construction is opt-in by extending the package `Base` (directly or transitively). The
**only** way to construct is the generated static `.new({ … })`; a direct `new X()` is a
compile-time error (branded construct signature). **A class that extends `Base` must not
declare its own constructor** — if you need a constructor, don't extend `Base` (use a
plain consumer / manual construction instead). See §9.

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 7.1 | Mixin-less construction class (`class M extends Base`), `.new(config)` | ✅ | `construction-public-only.t.ts` (`Model`, `Model2`) |
| 7.2 | Mixin consumer construction (`extends Base implements Mixin`), `.new` | ✅ | `construction-public-only.t.ts` (`ConstructableConsumer`) |
| 7.3 | Construction via an intermediate base (`Consumer extends Base-descendant`) — 1 level transitive | ✅ | `construction-public-only.t.ts`, `construction-allow-undefined-required.t.ts` |
| 7.4 | Standalone construction-base **mixin** (`@mixin() M extends Base`), `M.new()` | ✅ | `construction-mixin-standalone.t.ts` |
| 7.5 | `public`-only config (non-`public` fields excluded) | ✅ | `construction-public-only.t.ts`, `construction-public-only-generics.t.ts` |
| 7.5a | A **get-only** accessor on a construction class is excluded from `.new` config (not assignable) yet works on the instance | ✅ | `construction-accessor-config.t.ts` |
| 7.5c | A **settable** accessor (get/set or set-only) is **included** in `.new` config (public + assignable; `.new`'s `Object.assign` fires the setter), typed by the setter's parameter type; emit + source-view | ✅ | `construction-settable-accessor-config.t.ts`. Fixed: config-property collection now also gathers public set-accessors (`source-file-facts.ts`). A get-only accessor stays excluded. See Resolved. |
| 7.5b | **Constrained** generic construction (`class R<T extends Entity> extends Base`): constraint preserved on `.new<T>` and `<ClassName>Config<T>`; inference respects it | ✅ | `construction-generic-constrained.t.ts` |
| 7.5d | A **split** get/set accessor (getter type ≠ setter type, e.g. `get():number`/`set(v:number\|string)`) in `.new` config is typed by the **setter** parameter type (since `.new`'s `Object.assign` fires the setter) — `.new({ value: <setter-valid> })` compiles | ✅ | `construction-split-accessor-config.t.ts`. A settable accessor is emitted as an explicit `name?: <setterParamType>` config member (not `Pick<Class, name>`, which would read the getter type), so the setter type is honored in emit and source-view. Cross-file imported mixin accessors (whose setter type node is unavailable) still fall back to `Pick`. See Resolved. |
| 7.5e | A **mixin-contributed** public settable accessor flows into a construction **consumer's** `.new` config (as an optional key, typed by the setter), alongside the mixin's public **data fields** — the consumer's `Object.assign` fires the inherited setter the same way | ✅ | `construction-mixin-accessor-config.t.ts` (config alias carries the mixin's `label`; `@ts-expect-error` on a number argument proves the setter typing) |
| 7.6 | Optional (`?`), required, and definite-assignment (`!`) config fields | ✅ | `construction-public-only.t.ts` |
| 7.6a | **readonly** data fields (immutable value-object): accepted by `.new` config **and** immutable on the constructed instance (post-construction reassignment is a type error) | ✅ | `construction-readonly-config.t.ts` |
| 7.7 | `.new` excludes methods / rejects unknown keys | ✅ | `construction-public-only.t.ts`, `construction-public-only-generics.t.ts` |
| 7.8 | `initialize` override runs after config assignment | ✅ | `construction-public-only.t.ts`, `source-transform-cross-file-construction.t.ts` |
| 7.9 | Generated `<ClassName>Config` alias shape (public config fields only; excludes methods/unknowns) and its use as the `initialize` parameter type | ✅ | `construction-config-helper.t.ts` |
| 7.10 | Generic construction class, explicit + inferred `.new<T>` | ✅ | `construction-public-only-generics.t.ts` |
| 7.11 | `allowUndefinedForRequiredProperties` option | ✅ | `construction-allow-undefined-required.t.ts` |
| 7.12 | **Deep** construction subclassing (subclass of a construction *consumer*, 2+ levels): `.new` aggregates inherited config along the `extends` chain **and** from the intermediate bases' mixins (including transitive mixin-to-mixin dependencies) | ✅ | `construction-deep-subclass.t.ts` (local), `source-transform-cross-file-construction.t.ts` (cross-file, §10.7) |
| 7.13 | Named config alias `<ClassName>Config` (generic: `<ClassName>Config<T>`; exported per §7.15) referenced by `static new`; names `.new(...)` errors instead of inline `Pick`; reusable as a factory/annotation type **and** as the strict `initialize` parameter type — for a plain class **or** a `@mixin` (including through a mixin dependency chain); `_`-suffixed on name collision | ✅ | `source-transform-construction-config-alias.t.ts`, `source-transform-consumer-emit.t.ts`, `source-transform-mixins.t.ts`, `construction-public-only.t.ts`, `construction-config-helper.t.ts` |
| 7.15 | The generated `<ClassName>Config` alias's **`export` tracks the class's own**: an exported class (or `@mixin`) gets `export type <Name>Config`; a module-local class gets a non-exported `type <Name>Config` (so an internal class does not leak the alias, and a fully-internal class with no exported reference is elided from `.d.ts` entirely) — mirrors the mixin factory's `exportModifiersOf`; `export default` → non-exported alias | ✅ | `construction-config-alias-export.t.ts` |
| 7.14 | A construction consumer **or** a construction mixin applying several mixins that each override `initialize` with their own config does not hit a TS2320 merge conflict (the generated `$base` interface re-declares the `Base.initialize` protocol member when the class declares no own override); the merged config still requires every contributed field; the synthetic member does not crash editor rename/definition | ✅ | `source-transform-construction-config-alias.t.ts`, `tsserver-construction-config-alias.t.ts`, `source-transform-cross-file-construction.t.ts` |

## 8. Direct-`new` guard (this is compile-time only; runtime untouched)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 8.1 | `new Model()` on a mixin-less construction class → `TS2554` | ✅ | `emit-source-view-diagnostic-parity.t.ts` |
| 8.2 | `new Widget({…})` on a construction consumer → `TS2353` + descriptive message | ✅ | `emit-source-view-diagnostic-parity.t.ts`, `tsserver-diagnostics.t.ts` |
| 8.3 | Guard identical in emit (`tsc`) and source-view (`--noEmit`) modes | ✅ | `emit-source-view-diagnostic-parity.t.ts` |
| 8.4 | Guard surfaces in tsserver/IDE with the descriptive message | ✅ | `tsserver-diagnostics.t.ts` |
| 8.5 | Guard on a **transitive** subclass (`Consumer extends Base-descendant`, 1+ levels) | ✅ | `construction-deep-subclass.t.ts` (`@ts-expect-error new X()` at two depths), `construction-allow-undefined-required.t.ts` |
| 8.6 | Static factory call (`Model.new(…)`) is **not** flagged | ✅ | `tsserver-diagnostics.t.ts` |
| 8.7 | Brand preserves assignability (`.mix`, `instanceof`, `AnyConstructor` slots) | ✅ | covered transitively by all construction + manual-mix fixtures staying green |

## 9. Construction constraints (unsupported by design)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 9.1 | A class that `extends Base` declaring its own constructor | n/a | **Unsupported by design**: extend `Base` ⇒ no constructor (construct via `.new`); need a constructor ⇒ don't extend `Base` (plain consumer / manual construction). Left informal: not enforced with a diagnostic today (such a class is simply left unbranded). Don't add tests blessing it as a feature. |

## 10. Cross-file vs single-file

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 10.1 | Imported mixins (named / default / type-only) used by a consumer | ✅ | `consumer-imported-mixins.t.ts`, `default-mixin-consumer.t.ts`, `type-only-imported-mixin.t.ts` |
| 10.1a | Imported mixin's **accessors** (get-only + get/set) resolved on a cross-file consumer, clean in emit **and** source-view | ✅ | `accessor-mixin.ts` + `consumer-imported-accessor.t.ts` |
| 10.1b | **Aliased** mixin import (`import { Logger as Log }`): resolution follows the imported symbol (not the local binding text), so an aliased mixin is recognized and applied | ✅ | `imported-mixin-resolution.t.ts` ("resolves an aliased mixin import") |
| 10.1c | Mixin imported through a **re-export barrel** resolves & applies, across every re-export shape: **named** (`export { Logger } from`), **aliased** (`export { Logger as Renamed } from`), **star** (`export * from`), **default passthrough** (`export { default as Logger } from` a default-exported mixin), and **nested** (barrel of a barrel) | ✅ | `imported-mixin-resolution.t.ts` (5 shapes + aliased import). Fixed via `addReExportAliasKeys` (`registry.ts`): the registry adds `registryKey(reExportingFile, exportedName) → entry` for each re-exported mixin, resolved through the type-checker's alias chain — so the consumer's structural lookup hits. See Resolved. |
| 10.2 | Imported required-base mixin (with / without a local base) | ✅ | `consumer-imported-mixins.t.ts`, `required-base-imported-no-base.t.ts` |
| 10.3 | Cross-file construction: ordinary class extends imported `Base` descendant | ✅ | `source-transform-cross-file-construction.t.ts` |
| 10.4 | Cross-file construction: consumer of imported `Base`-descendant mixin | ✅ | `source-transform-cross-file-construction.t.ts` |
| 10.5 | Cross-file construction: consumer of imported mixin extending `Base` directly + `initialize` | ✅ | `source-transform-cross-file-construction.t.ts` |
| 10.6 | Declaration-only mixin without a runtime value → diagnostic | ✅ | `tsserver-diagnostics.t.ts` |
| 10.7 | Cross-file deep subclassing of an **imported construction *consumer*** (intermediate base consumes a mixin) | ✅ | `source-transform-cross-file-construction.t.ts` ("aggregates an imported construction consumer's mixin config when subclassed across files") |
| 10.8 | **Transitive** (two-hop) mixin config into a consumer's `.new` across three files (mixin → mixin-implements-mixin → consumer) | ✅ | `source-transform-cross-file-construction.t.ts` ("aggregates transitive mixin config for a consumer across three files") |
| 10.9 | **Transitive** registry mixin config into a subclass's `.new` across four files (subclass of imported base whose mixin depends on another mixin) | ✅ | `source-transform-cross-file-construction.t.ts` ("aggregates transitive registry mixin config when subclassing an imported base across files") |
| 10.10 | Construction config (incl. transitive) survives a `.d.ts` package round-trip — standalone construction-base mixin `.new` | ✅ | `source-transform-cross-file-construction.t.ts` ("carries transitive construction config through a declaration (.d.ts) package") |
| 10.11 | A **consumer** that `implements` an imported `.d.ts` construction-base mixin gets its own `.new` (with aggregated, transitive config) | ✅ | `source-transform-cross-file-construction.t.ts` ("makes a consumer of a declaration (.d.ts) construction-base mixin construction-enabled") |
| 10.12 | A **subclass** of an imported `.d.ts` construction base (`extends Base` published as declarations) gets its own `.new` aggregating inherited config | ✅ | `source-transform-cross-file-construction.t.ts` ("makes a subclass of an imported declaration (.d.ts) construction base construction-enabled") |
| 10.13 | A **failing** `.new(...)` call (missing required field) across files reports a normal type error, never crashes the compiler | ✅ | `source-transform-cross-file-construction.t.ts` ("reports a failing cross-file `.new(...)` call as a type error without crashing the compiler") |

## 11. Diagnostics (custom, friendly messages)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 11.1 | Invalid mixin: abstract / constructor / private / `#private` / abstract member | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.2 | Invalid mixin: missing type annotations (property/return/param/accessor) | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.3 | Anonymous default mixin / anonymous consumer rejected | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.4 | Dynamic consumer base expression (`extends makeBase()`) rejected | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.5 | Static member collisions (field strict / method strict-only / disabled) | ✅ | `source-transform-diagnostics.t.ts`, `type-errors.ts` |
| 11.6 | Contract violation (mixin body does not satisfy `implements`) | ✅ | `type-errors.ts`, `emit-contract-conformance.t.ts` |
| 11.7 | **Index signature** on a mixin is now **supported** (was rejected): copied into the generated interface (emit + source-view), erased at runtime; the consumer gains the dynamic member shape | ✅ | `fixture-suite/src/mixin-index-signature.t.ts` (runtime + emit + stress corpus; source-view via the "stay clean" sweep). See Resolved. |
| 11.8 | Index signature with a **generic value type** (`[key: string]: V`): a consumer fixing the parameter (`implements Bag<string>`) gains a string-valued dynamic shape; erased at runtime | ✅ | `fixture-suite/src/mixin-generic-index-signature.t.ts` |

## 12. IDE / source-view (position-preserving) behavior

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 12.1 | Go-to-definition on members / class name / type params | ✅ | `tsserver-definition.t.ts`, `stress-references.t.ts` |
| 12.2 | Find-all-references | ✅ | `tsserver-references.t.ts`, `stress-references.t.ts` |
| 12.3 | Quickinfo / hover | ✅ | `tsserver-quickinfo.t.ts`, `stress-quickinfo.t.ts` |
| 12.4 | Rename | ✅ | `tsserver-rename.t.ts`, `stress-rename.t.ts` |
| 12.5 | Source position / trivia preserved | ✅ | `source-position-preservation.t.ts`, `source-view-trivia.t.ts`, `compiler-host-source-view.t.ts` |
| 12.6 | Navigation does not crash on member access | ✅ | `tsserver-navigation-members-crash.t.ts` |
| 12.7 | Diagnostics land on the same source line in emit vs source-view | ✅ | `emit-source-view-diagnostic-parity.t.ts` |
| 12.8 | Base-name navigation limitation (generic / construction / qualified base) | ⚠️ | documented limitation; navigation correctness for the *supported* base shape is tested |
| 12.9 | Definition / quickinfo / find-references / rename on a generated `<ClassName>Config` alias reference do not crash the server; definition lands in the owning class, quickinfo expands the config type (the synthetic alias *name* renders cosmetically as the class brace) | ✅ | `tsserver-construction-config-alias.t.ts`, `construction-config-alias-usage.t.ts` (corpus fixture → every `stress-*` probe) |

## 13. Declaration emit (`.d.ts`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 13.1 | `.d.ts` output builds and the declared types run | ✅ | `declaration-fixture-build-and-runtime.t.ts`, `declaration-fixture-suite/` |
| 13.2 | tsserver declaration-emit diagnostics | ✅ | `tsserver-declaration-emit-diagnostics.t.ts` |
| 13.3 | Emit contract conformance | ✅ | `emit-contract-conformance.t.ts` |
| 13.4 | The generated `static new` factory is **stripped from JS emit** (it only forwards to the inherited `Base.new`) while declaration emit **keeps** the typed `static new(props: <Class>Config): <Class>` — runtime uses the inherited `Base.new` | ✅ | `emit-strips-generated-static-new.t.ts` |

## 14. Stress / fuzz

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 14.1 | Randomized mixin graphs: definition, diagnostics, edit, quickinfo, references, rename | ✅ | `stress-*.t.ts` (seeded) |

---

## Open questions / discovered gaps

- **Go-to-definition on a member reached through a manual `.mix(Base)` does not land on the
  member's real declaration.** `class X extends Main.mix(UserBase)` then `this.mainMethod()`:
  the diagnostic is clean and the type resolves, but definition jumps to a collapsed span
  (for a *dependent* mixin, even the wrong class) instead of `Main.mainMethod`. The
  `implements`-consumer path is unaffected (it resolves correctly). Recorded as a **skipped**
  (`xit`) test in `tsserver-definition.t.ts` → "tsserver go-to-definition resolves a member
  reached through a manual .mix of a dependent mixin" (fix deferred).
  - *Why.* The member is reached through the synthetic `.mix` apply type, whose instance type
    is an inline member literal; that subtree is collapsed to a non-source range to avoid a
    source-view stranding crash (invariant #5), so navigation resolves onto the collapsed
    span. Navigating to the *real* code needs the instance type to reference the mixin by
    name (`Main`), like the `implements` path — but `.mix` lives in the mixin's OWN base
    expression (`class Main extends __Main$base`, `.mix` on the base cast), so referencing
    `Main` there is a self-base-reference (`TS2506`/`TS2310` "recursively references itself as
    a base type"). The inline literal exists precisely to avoid naming the mixin in its own
    base. Verified: the name-reference fix compiles the definition test green but regresses
    generic-required-base, diagnostic parity, and stress-references with the circular error.
  - *Possible deeper fixes (not attempted).* Move `.mix` off the mixin's base chain (a direct
    static on the class, so a self-returning static is non-circular), or generate a separate
    top-level navigable interface for the mixin's own members and reference that. Both are
    larger, position-sensitive changes. Same trilemma family as the §12.9 quickinfo
    limitation: navigable real positions strand → crash; collapsed → no navigation; name
    reference → circular.

- **Quickinfo on a `<ClassName>Config` reference renders the alias *name* as the class
  brace (§12.9), cosmetic.** Hovering a reference (`config?: AccountConfig`) shows
  `type } = Pick<Account, "id" | "balance"> & Partial<Pick<Account, "label">>` — the body
  is correct, but the name is a `}` (for a generic alias, `type }<}> = { … }`). This is a
  direct consequence of the crash fix, not a separate bug.
  - *Mechanism.* TS renders a declared symbol's name via
    `getNameOfSymbolAsWritten` → `declarationNameToString` → `getTextOfNode`, i.e. the
    **source text under the name node's span**. There is no `escapedText` fallback: that
    function returns either the source text or `"(Missing)"`. So the displayed name is
    always whatever user text sits under wherever the name node is positioned.
  - *Why it can't be fixed safely.* In source view we do not own the file text (tsserver
    owns the user's buffer); we only move AST ranges over it. The literal string
    `<ClassName>Config` exists nowhere the synthetic alias declaration can legally sit. The
    only crash-free anchor collapses the whole alias subtree onto `declaration.end` (just
    past the class `}`), so the name reads `}`. Every alternative was measured and rejected:
    pinning the name to a real source occurrence of the alias-name string (only present at
    a *reference* site) or to the class-name span moves it off the collapsed anchor, which
    **strands the identifier in trivia** — a real `getChildren` crash; `source-view-trivia`
    fails for every construction class — and also breaks emit↔source-view diagnostic parity
    and declaration emit. Pinning to a reference additionally redirects go-to-definition
    onto that reference, because the name node's position drives **both** the displayed
    name and the definition target (they read the same span).
  - *Not affected.* The hover **type body** is correct, **go-to-definition** lands on the
    owning class, and **`.new(...)` error messages** show the real `AccountConfig` (they
    resolve through the user's own real `AccountConfig` text, not the synthetic
    declaration). Only the alias-name token in the hover header is cosmetic.
  - *Worth revisiting.* If a future approach can decouple the displayed name from the name
    node's source span (e.g. a services-level name override, or a way to give the synthetic
    declaration real backing text without stranding), the `}` could become the real name.
    Until then it is the accepted cost of the only non-crashing anchor.

## Resolved (kept here for history)

- **Split get/set accessor typed by the setter in `.new` config (§7.5d).** A settable accessor
  whose getter and setter types differ used to be typed by the getter, because the config was
  built as `Pick<Class, name>` (which reads the getter type) — so a setter-valid value was
  rejected (`TS2322`). Fixed by carrying the setter's parameter type on `ConfigProperty.valueType`
  (`source-file-facts.ts`) and emitting settable accessors as explicit `name?: <setterType>`
  members in `createConstructionConfig` (`construction-config.ts`) instead of folding them into
  the `Pick`. The setter type is `getSynthesizedDeepClone`d (position-less synthetic), so it is
  safe in both emit and source-view. A cross-file imported mixin accessor has no available type
  node, so it still falls back to `Pick` (getter type) — a documented narrower limitation.
  Covered by `construction-split-accessor-config.t.ts`.
- **Re-export barrel mixin resolution (§10.1c).** A consumer importing a mixin through a
  re-export (`export { X } from`, `export { X as Y } from`, `export * from`, `export { default
  as X } from`, or a nested barrel) used to leave the consumer untransformed (`TS2420`/`TS2335`/
  `TS2339`) because the registry keyed mixins only by their declaring file. Fixed with a
  checker-based pass `addReExportAliasKeys` (`registry.ts`): for every module that re-exports,
  it follows each export's alias chain (`getAliasedSymbol`; `export *` surfaces the original
  symbol directly) to the declaring mixin and registers an alias key
  `registryKey(reExportingFile, exportedName) → entry`. Run before dependency resolution, so a
  mixin **dependency** imported via a barrel resolves too. The checker is fetched lazily and only
  files containing `export … from` are inspected, so direct-import projects pay ~nothing. The
  consumer-resolution path is unchanged (its structural lookup now simply hits). Covered by
  `imported-mixin-resolution.t.ts`.
- **Index signatures on a mixin are now supported (§11.7).** Was rejected (with a diagnostic
  that even mislabelled it a "constructor"). Now `isSupportedMixinClassMember` accepts an
  `IndexSignatureDeclaration`, and it is copied into the generated mixin interface (emit:
  `interface-members.ts`; source-view: `createSourceViewMixinInstanceMembers`) so a consumer
  gains the dynamic member shape. It is type-only, erased at runtime. Covered by
  `fixture-suite/src/mixin-index-signature.t.ts` (all three planes).
- **A defaulted type parameter on a mixin (§6.5).** `@mixin() class M<V = number>` failed
  `TS2706` because the generated `.mix` appended a *required* `__MixinBase` after the
  optional own param. Fixed in `createMixinApplyType` (`mixin-apply-type.ts`): when the mixin
  has any defaulted own type parameter, `__MixinBase` gets a default equal to its constraint
  (so it is optional too). For mixins without a defaulted param it stays required, preserving
  §5.3 (explicit mixin type args still require the base type arg). Covered by
  `generic-mixin-defaulted-type-param.t.ts` (emit + source-view).
- **A settable accessor in `.new` config (§7.5c).** A public set-accessor (set-only or the
  setter of a get/set pair) is now collected as a construction config property
  (`collectClassMemberFacts` in `source-file-facts.ts`), typed by the setter's parameter type
  and treated as optional. `.new`'s runtime `Object.assign` already fired the setter, so this
  closed a type-only gap. A get-only accessor stays excluded (not assignable; `Object.assign`
  would throw). Covered by `construction-settable-accessor-config.t.ts` (emit + source-view)
  and the get-only exclusion by `construction-accessor-config.t.ts`.
- **Manual `.mix` of a dependent mixin in source-view (§5.4-sv).** `class X extends
  Main.mix(Base)` where `Main implements Dep` reported a spurious `TS2339` on `Main`'s own
  method in the IDE (emit was clean). Cause: the source-view value cast intersected
  `ClassStatics<typeof Dep>` — which carries the dependency's framework `mix` (returning the
  dependency's narrower instance) — *before* the mixin's own `mix`, so it won overload
  resolution. Fixed by excluding `mix` from the inherited dependency statics
  (`Omit<ClassStatics<typeof Dep>, "mix">` in `createMixinValueCastType`). Guarded by
  `tsserver-diagnostics.t.ts` → "a manual .mix of a dependent mixin is clean in source-view".

- **Named config alias `<ClassName>Config` (§7.13).** Added: each construction class
  (consumer, plain `Base` descendant, construction-base mixin) emits an exported
  `type <ClassName>Config<TParams> = <config>` referenced by `static new`, so `.new(...)`
  errors read the alias instead of a verbose `Pick<…>`. The alias is a sibling anchored at
  `declaration.end` (outside the class) and listed after it — an in-class anchor strands an
  identifier (invariant #5), a `[-1,-1]` collapse breaks stress parity. Emit collapses the
  subtree for column parity; source view only collapses the cloned generic type params.
  `.d.ts` readers resolve the alias reference back to its body. As part of this the
  `Config<T>` helper was removed and `Base.initialize`/`Base.new` retyped to `unknown`, so
  the strict alias is usable as the `initialize` parameter type. See
  `positionConstructionConfigAlias`; covered by `source-transform-construction-config-alias.t.ts`.
- **Mixin `initialize` overrides with their own config (§7.14).** Resolved: a `@mixin` can
  type its `initialize` override with its own `<MixinName>Config` (earlier it was forced to
  `unknown`). The blocker was TS2320 at a consumer applying several such mixins — its
  generated `interface <C>$base extends Base, A, B` inherited non-identical `initialize`
  members. Fix: the consumer base interface re-declares the `Base.initialize` protocol
  member, which overrides the conflicting inherited ones. The same merge happens on a
  construction **mixin** that applies (implements) other initialize-overriding mixins and
  declares no own override — its generated interface (`interface <Mixin>` in emit,
  `__<Mixin>$base` in source view) gets the protocol member too (gated by
  `isConstructionBaseOptIn` + having dependencies + no own `initialize`, via
  `declaresInstanceInitialize`/`constructionProtocolInitializeSignature` in
  `interface-members.ts`). The member is synthetic; in source view it normalizes onto the
  off-screen `$base` range and `alignGeneratedNavigableNodesWithParseTree` clears its
  `Synthesized` flag (`MethodSignature` added to the navigable kinds) so rename/definition on
  a user `initialize` does not crash. Override the parameter as required
  (`config: <ClassName>Config`), or `| undefined` for an all-optional class; `config?:` also
  works.
- **Subclassing a construction mixin directly (§7.15).** A class that `extends` a construction
  mixin and adds a required config field used to hit a static-side `TS2417`: the subclass's
  generated `static new(props: SubConfig)` was not assignable to the mixin's inherited `new`,
  exposed in the value cast as a function-typed **property** (`new: (props) => …`) which is
  checked contravariantly under `strictFunctionTypes`. Fixed by emitting that `new` as a
  **method** with a string-literal name (`"new"(props): …`) in `createMixinConstructionNewType`
  — method parameters are bivariant, so the required-field subclass stays assignable, and
  `"new"` (not a bare `new`, which parses as a construct signature) keeps `.new(...)` callable.
  (Extending a mixin directly is not the idiomatic pattern — prefer `implements` — but it now
  works.) Covered by `source-transform-construction-config-alias.t.ts` and
  `tsserver-construction-config-alias.t.ts`.
- **Deep construction subclassing — local (§7.12).** Fixed: `baseConfigProperties`
  (`construction-config.ts`) now recurses the `extends` chain and the mixins each
  intermediate base consumes (transitively), which also restores static-side `new`
  assignability along the chain (was `TS2417`). Covered by `construction-deep-subclass.t.ts`.
- **Deep construction subclassing — cross-file (§10.7).** Fixed: the cross-file
  construction-base **registry** (`registry.ts`) now resolves an imported base's
  `implements` mixins (via the mixin registry) and folds their config into the
  accumulated entry, not only the `extends` chain. Shared helper
  `accumulateRegisteredMixinConfig` (`model.ts`). Covered by
  `source-transform-cross-file-construction.t.ts`.
- **Constructor on a `Base`-extending class (§9.1).** Decision: unsupported by design,
  left informal (no diagnostic). The contract is "extend `Base` ⇒ no constructor". Not
  blessed as a feature in tests or the README.
- **Construction through a `.d.ts` package (§10.11, §10.12).** Fixed: a consumer of an
  imported `.d.ts` construction-base mixin, and a subclass of an imported `.d.ts`
  construction base, are both now construction-enabled. `collectDeclarationFileMixinCandidates`
  recovers the package-base flag from the `RuntimeMixinClass<Base>` marker; the
  construction-base registry now also scans `.d.ts` classes, reading their aggregated
  config off the emitted `static new(props: <Name>Config)` by resolving the exported alias
  to its `Pick`/`Partial` body. Covered by the two declaration tests in
  `source-transform-cross-file-construction.t.ts`.
- **Compiler crash on a failing cross-file `.new(...)` (§10.13).** Fixed: a failed
  overloaded `.new` call elaborates against the synthetic implementation overload, whose
  `new` name had no source position in the source-view tree — `getErrorSpanForNode`
  asserted (`skipTrivia(-1)` overrun, TS #20809) and crashed `tsc`. The name is now pinned
  to the first overload's real anchor (`createConstructionMembers`, source-view branch), so
  the span resolves and a normal type error is reported.
