# Supported use cases & test coverage

A catalog of every scenario `ts-mixin-class` is meant to support, with the test(s)
that cover it. Kept as a checklist for future work: when a feature changes, find its
row here, confirm the listed tests still pin the behavior, and add a row for anything
new.

Status legend:

- ✅ covered — a test asserts this directly
- ⚠️ partial — covered only implicitly, in one mode, or as a side effect of another test
- ❌ gap — no test, or known-broken (see notes)

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

## 5. Manual application (`.mix(Base)`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 5.1 | `class X extends Mixin.mix(Base)` keeps base ctor, statics, `instanceof` | ✅ | `manual-mix.t.ts`, `source-transform-consumer-typecheck.t.ts` |
| 5.2 | Generic manual mix (`Mixin.mix<T, typeof Base>(Base)`) | ✅ | `manual-mix.t.ts`, `source-transform-consumer-typecheck.t.ts` |
| 5.3 | Generic mix requires the base type arg when mixin args are explicit | ✅ | `manual-mix.t.ts` (`@ts-expect-error`) |

## 6. Generics

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 6.1 | Generic mixin, generic consumer, generic `super`, instance type | ✅ | `consumer-constructor.t.ts`, `mixin-self-reference.t.ts` |
| 6.2 | Generic mixin statics | ✅ | `mixin-statics.t.ts` |
| 6.3 | Generic type arguments preserved through imported mixins | ✅ | `consumer-imported-mixins.t.ts`, `type-only-imported-mixin.t.ts` |

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
| 7.6 | Optional (`?`), required, and definite-assignment (`!`) config fields | ✅ | `construction-public-only.t.ts` |
| 7.7 | `.new` excludes methods / rejects unknown keys | ✅ | `construction-public-only.t.ts`, `construction-public-only-generics.t.ts` |
| 7.8 | `initialize` override runs after config assignment | ✅ | `construction-public-only.t.ts`, `source-transform-cross-file-construction.t.ts` |
| 7.9 | `Config<this>` helper shape (excludes methods/unknowns) | ✅ | `construction-config-helper.t.ts` |
| 7.10 | Generic construction class, explicit + inferred `.new<T>` | ✅ | `construction-public-only-generics.t.ts` |
| 7.11 | `allowUndefinedForRequiredProperties` option | ✅ | `construction-allow-undefined-required.t.ts` |
| 7.12 | **Deep** construction subclassing (subclass of a construction *consumer*, 2+ levels): `.new` aggregates inherited config along the `extends` chain **and** from the intermediate bases' mixins (including transitive mixin-to-mixin dependencies) | ✅ | `construction-deep-subclass.t.ts` (local), `source-transform-cross-file-construction.t.ts` (cross-file, §10.7) |
| 7.13 | Exported named config alias `<ClassName>Config` (generic: `<ClassName>Config<T>`) referenced by `static new`; names `.new(...)` errors instead of inline `Pick`; reusable as a factory/annotation type; `_`-suffixed on name collision. **Not** usable as a stricter `initialize` override (base `initialize` is all-optional — keep `Config<this>` there) | ✅ | `source-transform-construction-config-alias.t.ts`, `source-transform-consumer-emit.t.ts`, `source-transform-mixins.t.ts` |

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

## 13. Declaration emit (`.d.ts`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 13.1 | `.d.ts` output builds and the declared types run | ✅ | `declaration-fixture-build-and-runtime.t.ts`, `declaration-fixture-suite/` |
| 13.2 | tsserver declaration-emit diagnostics | ✅ | `tsserver-declaration-emit-diagnostics.t.ts` |
| 13.3 | Emit contract conformance | ✅ | `emit-contract-conformance.t.ts` |

## 14. Stress / fuzz

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 14.1 | Randomized mixin graphs: definition, diagnostics, edit, quickinfo, references, rename | ✅ | `stress-*.t.ts` (seeded) |

---

## Open questions / discovered gaps

None outstanding.

## Resolved (kept here for history)

- **Named config alias `<ClassName>Config` (§7.13).** Added: each construction class
  (consumer, plain `Base` descendant, construction-base mixin) emits an exported
  `type <ClassName>Config<TParams> = <config>` referenced by `static new`, so `.new(...)`
  errors read the alias instead of a verbose `Pick<…>`. The alias is a sibling anchored at
  `declaration.end` (outside the class) and listed after it — an in-class anchor strands an
  identifier (invariant #5), a `[-1,-1]` collapse breaks stress parity. Emit collapses the
  subtree for column parity; source view only collapses the cloned generic type params.
  `.d.ts` readers resolve the alias reference back to its body. **Finding:** the strict
  alias is *not* a valid `initialize` override (the base `initialize` is all-optional, so
  TS rejects the narrowing) — `Config<this>` stays the recommendation there. See
  `positionConstructionConfigAlias`; covered by `source-transform-construction-config-alias.t.ts`.
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
