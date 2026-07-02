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
| 1.13 | A mixin's **static GET-ONLY accessor** (no setter), not the static get/set pair of §1.11: inherited onto the consumer's constructor as a **read-only** static (getter computes; assignment is a type error, on the consumer's own static type *and* through `typeof Mixin`) | ✅ | `fixture-suite/src/mixin-static-getonly-accessor.t.ts` |
| 1.14 | A mixin method with a **polymorphic `this` return type** (`self(): this`): at the consumer call site `this` narrows to the **consumer** type, so a consumer-specific member chains off the inherited method (fluent/builder shape); the chain mutates state at runtime | ✅ | `fixture-suite/src/mixin-polymorphic-this-return.t.ts` |
| 1.15 | A mixin contributing a **`readonly` data field** (not a get-only accessor): the `readonly` modifier survives into the consumer's generated interface member — present and initialized at runtime, immutable at type level (reassignment on the instance is a type error) | ✅ | `fixture-suite/src/mixin-readonly-field.t.ts` |
| 1.16 | **Async / generator / async-generator** mixin methods: modifiers survive into the consumer's interface; `await`, `for..of`, `for await..of` work through them; an async override chains through `super` | ✅ | `fixture-suite/src/mixin-async-generator-methods.t.ts` |
| 1.17 | **Computed symbol-named** members (`[Symbol.iterator]`, a module-level `unique symbol`): copied into the generated interface, making the consumer iterable and the unique-symbol method callable | ✅ | `fixture-suite/src/mixin-symbol-members.t.ts` |
| 1.18 | A `static {}` block on a `@mixin` is **supported**: it stays in the factory class expression, so it runs once per distinct base the mixin is applied over (canonical class + each application; base-less consumers each bring their own `__X$empty` base), memoized per base — the same per-application semantics as static field initializers. Inside the block refer to the class as `this` (the class name is in TDZ during the canonical run). A consumer's static block: §2.9 | ✅ | `fixture-suite/src/mixin-static-block.t.ts`, `source-transform-diagnostics.t.ts` |
| 1.19 | A class applying a local mixin **declared LATER in the same scope** is rejected with a native diagnostic (TS990008, spanned on the heritage reference) in both planes — plain TS allows the type-only `implements`, but the generated VALUE reference would hit the const TDZ; a **deferred-scope** use (function body applying a later top-level mixin) stays legal | ✅ | `source-transform-diagnostics.t.ts` |
| 1.20 | **Parameter properties** in a mixin's own constructor (`constructor(public label: string = …)`) declare real instance members, so they become generated-interface members (with `readonly` surviving); was an EMIT-only hole — the runtime instance carried the member while the type denied it (source view was already clean, a plane divergence). Defaults are required in practice (the chain calls the constructor without arguments). `private`/`protected` and missing-type parameter properties are diagnosed like declared fields | ✅ | `fixture-suite/src/mixin-parameter-properties.t.ts`, `source-transform-diagnostics.t.ts` |
| 1.21 | **Exotic-but-legal member shapes** in one sweep: a DEFAULT parameter value (translates to an optional signature parameter — an interface cannot carry an initializer), OPTIONAL + REST parameters, a SET-ONLY accessor (modeled as a writable property, as native TS does), STRING-LITERAL (`"my-method"`) and NUMERIC (`0`) member names, OPTIONAL members (`hint?: string`, bodyless `maybe?(): string`) | ✅ | `fixture-suite/src/mixin-exotic-member-shapes.t.ts` |
| 1.22 | An INSTANTIATED **namespace merged with a `@mixin` class** (the static-helper pattern) is rejected with a native diagnostic (**TS990009**, spanned on the namespace name, both planes) — the class is rewritten into a `const`, and a namespace cannot merge with it; the message points at static members as the alternative. A **TYPE-ONLY** namespace merge (`export namespace M { export type … }`) stays legal (qualified type access needs no value merge) | ✅ | `mixin-declaration-merging.t.ts` |
| 1.23 | An **interface merged with a `@mixin` class** adds TRUSTED members to the mixin type (plain-TS class-interface-merge semantics): the member joins the generated interface chain, so a consumer's type carries it WITHOUT being forced to re-declare it | ✅ | `mixin-declaration-merging.t.ts` |
| 1.24 | **`this` in a parameter position** (`same(other: this)`) — narrows to the consumer at the call site (a bare mixin instance is rejected) — and a member type referencing the **mixin's own name** (`clone(): Tagged`) | ✅ | `fixture-suite/src/mixin-this-typed-members.t.ts` |
| 1.25 | A `@mixin` with a mixin **dependency AND a plain interface contract** in one `implements` list (`@mixin() class Loud implements Greeter, Nameable`): the dependency is applied, the contract binds the mixin's own body and flows to consumers | ✅ | `fixture-suite/src/consumer-mixed-heritage.t.ts` |
| 1.26 | A **type-only import referenced ONLY from a mixin member signature** survives the transform's import pruner in both planes (the generated interface clones the type node, keeping the name referenced) | ✅ | `transform-prunes-unused-imports.t.ts` |

## 2. Consumers (`implements`)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 2.1 | No-base consumer (`class C implements A, B`) | ✅ | `consumer-inheritance.t.ts` (`NoBaseConsumer`) |
| 2.2 | Consumer with an explicit (non-`Base`) base + `super` into mixins | ✅ | `consumer-inheritance.t.ts`, `consumer-imported-mixins.t.ts` |
| 2.3 | Consumer subclassed again (`class Sub extends Consumer`) | ✅ | `consumer-inheritance.t.ts` (`SubConsumer`) |
| 2.4 | Consumer with its own explicit constructor (no `Base`) | ✅ | `fixture-suite/src/consumer-constructor.t.ts` |
| 2.5 | Consumer base statics inherited | ✅ | `mixin-statics.t.ts`, `consumer-inheritance.t.ts` |
| 2.6 | **Two mixins declaring the SAME-named instance method** with a compatible signature (instance-member overlap, vs the diagnosed STATIC collision of §11.5): merges cleanly into the consumer's interface (no TS2320), stays callable, and the **first-listed mixin in `implements` wins deterministically** at runtime (C3 order) | ✅ | `fixture-suite/src/mixin-shared-instance-member.t.ts` |
| 2.7 | **Abstract consumer** (`abstract class Task implements Mixin` with its own `abstract` method): stays abstract (`new Task()` rejected, the abstract method required of subclasses) while the mixin members are injected and usable from a concrete method; a concrete subclass carries the mixin members and matches `instanceof` | ✅ | `fixture-suite/src/mixin-abstract-consumer.t.ts` |
| 2.8 | A **user decorator on a consumer** (the ts-serializable `@serializable()` pattern): runs once, receives the FINAL (transformed) constructor; a decorated construction consumer still builds through `.new` | ✅ | `fixture-suite/src/consumer-user-decorator.t.ts` |
| 2.9 | A **`static {}` initialization block on a consumer**: survives the heritage rewrite and runs once on the final constructor (on a `@mixin` it runs per application — §1.18) | ✅ | `fixture-suite/src/mixin-static-block.t.ts` |
| 2.10 | A consumer implementing a MIXIN and a **PLAIN interface side by side** (`implements Greeter, Nameable`): the mixin is applied while the plain interface stays an ordinary type contract — still REQUIRED of the class body (`@ts-expect-error` pins the enforcement) | ✅ | `fixture-suite/src/consumer-mixed-heritage.t.ts` |
| 2.11 | The **same mixin listed twice** (`implements Greeter, Greeter`) — degenerate but tolerated: applies once (per-base memoization), no type error | ✅ | `fixture-suite/src/consumer-mixed-heritage.t.ts` |
| 2.12 | A consumer's **own constructor with a parameter property** (`constructor(public tag: string)`) — preserved verbatim, both members present (also in a nested scope) | ✅ | `fixture-suite/src/nested-scope.t.ts` (`makeParamPropertyConsumer`) |
| 2.13 | A **subclass of a consumer adding MORE mixins** (`class Amphibian extends Animal implements Swims`) — the everyday layering pattern: both mixin sets present, `super` threads into the subclass's own mixin layer first, `instanceof` matches every layer, and the base consumer does NOT match the subclass's mixin | ✅ | `fixture-suite/src/consumer-subclass-extra-mixin.t.ts` |

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
| 5.6 | **Stacking two INDEPENDENT mixins** by nesting `.mix` (`extends A.mix(B.mix(Base))`) — distinct from a single `.mix` (§5.1) and from a dependent mixin (§5.4): both mixins' members and statics layer onto the base, the base constructor signature is kept, and `instanceof` matches the base and **both** mixins | ✅ | `fixture-suite/src/manual-mix-stacked.t.ts` |
| 5.7 | The documented dynamic-base workaround: **`const K = Mixin.mix(Base); class X extends K {}`** — behaves like the inline form (base ctor, members, `instanceof`), and the const is reusable by two subclasses | ✅ | `fixture-suite/src/manual-mix-const-base.t.ts` |
| 5.8 | **Construction through a manual `.mix` heritage** (`class X extends M.mix(BaseDescendant)`): NOT construction-recognized — the class keeps the inherited `.new` (no own config aggregation). Deferred: see TODO.md "Construction through a manual `.mix` heritage" | ⏭️ | `construction-composition.t.ts` (`xit`) |

## 6. Generics

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 6.1 | Generic mixin, generic consumer, generic `super`, instance type | ✅ | `consumer-constructor.t.ts`, `mixin-self-reference.t.ts` |
| 6.2 | Generic mixin statics | ✅ | `mixin-statics.t.ts` |
| 6.3 | Generic type arguments preserved through imported mixins | ✅ | `consumer-imported-mixins.t.ts`, `type-only-imported-mixin.t.ts` |
| 6.4 | **Multiple** type parameters and a **constraint** (`K extends string`) on a mixin, fixed by a consumer and forwarded (constrained) through a consumer | ✅ | `generic-mixin-variations.t.ts` |
| 6.5 | **Defaulted** type parameter on a mixin (`<V = number>`) compiles in emit + source-view | ✅ | `generic-mixin-defaulted-type-param.t.ts`. Fixed: the generated `.mix`'s synthetic `__MixinBase` now carries a default (equal to its constraint) when the mixin has a defaulted own param, so it is no longer a required-after-optional parameter (TS2706). See Resolved. |
| 6.6 | A mixin **METHOD with its own type parameter** (`mapItems<U>(project: (item: T) => U): U[]`), distinct from a class-level generic (§6.4): the method-level type parameter survives into the consumer's generated interface member and is inferred independently per call site | ✅ | `fixture-suite/src/mixin-generic-method.t.ts` |

## 7. Instantiation / construction (`extends Base`, static `.new`)

Construction is opt-in by extending the package `Base` (directly or transitively). The
**only** way to construct is the generated static `.new({ … })`; a direct `new X()` is a
compile-time error (branded construct signature). A class that extends `Base` **may** still
declare its own constructor — it is preserved and runs as the native-construct step of
`.new()`; the direct-`new` ban holds either way. (When the class declares its own
constructor the ban is enforced on the EMIT plane only; source view leaves it, since
poisoning the constructor there would shift the position-preserved body. See §9.)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 7.1 | Mixin-less construction class (`class M extends Base`), `.new(config)` | ✅ | `construction-public-only.t.ts` (`Model`, `Model2`) |
| 7.2 | Mixin consumer construction (`extends Base implements Mixin`), `.new` | ✅ | `construction-public-only.t.ts` (`ConstructableConsumer`) |
| 7.3 | Construction via an intermediate base (`Consumer extends Base-descendant`) — 1 level transitive | ✅ | `construction-public-only.t.ts`, `construction-fill-missed-initializers.t.ts` |
| 7.4 | Standalone construction-base **mixin** (`@mixin() M extends Base`), `M.new()` | ✅ | `construction-mixin-standalone.t.ts` |
| 7.5 | `public`-only config (non-`public` fields excluded) | ✅ | `construction-public-only.t.ts`, `construction-public-only-generics.t.ts` |
| 7.5a | A **get-only** accessor on a construction class is excluded from `.new` config (not assignable) yet works on the instance | ✅ | `construction-accessor-config.t.ts` |
| 7.5c | A **settable** accessor (get/set or set-only) is **included** in `.new` config (public + assignable; `.new`'s `Object.assign` fires the setter), typed by the setter's parameter type; emit + source-view | ✅ | `construction-settable-accessor-config.t.ts`. Fixed: config-property collection now also gathers public set-accessors (`source-file-facts.ts`). A get-only accessor stays excluded. See Resolved. |
| 7.5b | **Constrained** generic construction (`class R<T extends Entity> extends Base`): constraint preserved on `.new<T>` and `<ClassName>Config<T>`; inference respects it | ✅ | `construction-generic-constrained.t.ts` |
| 7.5d | A **split** get/set accessor (getter type ≠ setter type, e.g. `get():number`/`set(v:number\|string)`) in `.new` config is typed by the **setter** parameter type (since `.new`'s `Object.assign` fires the setter) — `.new({ value: <setter-valid> })` compiles | ✅ | `construction-split-accessor-config.t.ts`. A settable accessor is emitted as an explicit `name?: <setterParamType>` config member (not `Pick<Class, name>`, which would read the getter type), so the setter type is honored in emit and source-view. Cross-file imported mixin accessors (whose setter type node is unavailable) still fall back to `Pick`. See Resolved. |
| 7.5e | A **mixin-contributed** public settable accessor flows into a construction **consumer's** `.new` config (as an optional key, typed by the setter), alongside the mixin's public **data fields** — the consumer's `Object.assign` fires the inherited setter the same way | ✅ | `construction-mixin-accessor-config.t.ts` (config alias carries the mixin's `label`; `@ts-expect-error` on a number argument proves the setter typing) |
| 7.5f | A public **function-typed DATA field** (`onClick: () => string`) is **included** in `.new` config (it is an assignable property), while a declared **method** of the same call shape stays **excluded** — the config builder keys on declaration kind (property vs method), not on whether the type is a function; the supplied function is assigned and fires at runtime | ✅ | `fixture-suite/src/construction-function-typed-field.t.ts` |
| 7.5g | A **local mixin's GENERIC split accessor** (setter type references the mixin's own type param, `set value(input: T \| string)`) flowing into a construction **consumer** that fixes the param (`implements Boxed<number>`): the consumer's `.new` config types `value` by the **substituted** setter type (`value?: number \| string`), and **forwards** the consumer's own param when it does (`class Box<U> implements Boxed<U>` → `value?: U \| string`) — never a dangling `T` | ✅ | `construction-generic-mixin-accessor-config.t.ts`. Fixed: mixin config collection substitutes the mixin's type params with the consumer's `implements` type arguments before cloning the setter node (`substituteMixinConfigTypeParameters` in `construction-config.ts`); an unfixed param falls back to its default/`any`. Was a dangling-`T` TS2304 that broke construction in emit **and** source-view. See Resolved. |
| 7.6 | Config required-ness from the definite-assignment `!` (`public id!: T` required; every other public field optional; `?` is ordinary TS optionality, not a config marker) | ✅ | `construction-public-only.t.ts` |
| 7.6a | **readonly** data fields (immutable value-object): accepted by `.new` config **and** immutable on the constructed instance (post-construction reassignment is a type error) | ✅ | `construction-readonly-config.t.ts` |
| 7.7 | `.new` excludes methods / rejects unknown keys | ✅ | `construction-public-only.t.ts`, `construction-public-only-generics.t.ts` |
| 7.8 | `initialize` override runs after config assignment | ✅ | `construction-public-only.t.ts`, `source-transform-cross-file-construction.t.ts` |
| 7.9 | Generated `<ClassName>Config` alias shape (public config fields only; excludes methods/unknowns) and its use as the `initialize` parameter type | ✅ | `construction-config-helper.t.ts` |
| 7.10 | Generic construction class, explicit + inferred `.new<T>` | ✅ | `construction-public-only-generics.t.ts` |
| 7.11 | `fillMissedInitializersWith` option (default `"undefined"`): an instance construction field of ANY visibility (public/protected/private/unmarked) with no source initializer is filled (`undefined!`/`null!`, type not widened) for a stable object shape; `static`/`abstract`/`declare`/untyped excluded; `"nothing"` opts out | ✅ | `construction-fill-missed-initializers.t.ts` |
| 7.12 | **Deep** construction subclassing (subclass of a construction *consumer*, 2+ levels): `.new` aggregates inherited config along the `extends` chain **and** from the intermediate bases' mixins (including transitive mixin-to-mixin dependencies) | ✅ | `construction-deep-subclass.t.ts` (local), `source-transform-cross-file-construction.t.ts` (cross-file, §10.7) |
| 7.13 | Named config alias `<ClassName>Config` (generic: `<ClassName>Config<T>`; exported per §7.15) referenced by `static new`; names `.new(...)` errors instead of inline `Pick` in **both** planes — emit reprints the real name, and source view appends the alias as real text so the editor (diagnostics, hover, quickinfo, incl. generics `BoxConfig<number>`) names it too, with the companion `language-service-plugin` keeping the appended text out of navigation; reusable as a factory/annotation type **and** as the strict `initialize` parameter type — for a plain class **or** a `@mixin` (including through a mixin dependency chain); `_`-suffixed on name collision | ✅ | `source-transform-construction-config-alias.t.ts`, `source-transform-consumer-emit.t.ts`, `source-transform-mixins.t.ts`, `construction-public-only.t.ts`, `construction-config-helper.t.ts`, `tsserver-construction-config-alias.t.ts`, `tsserver-config-alias-navigation.t.ts` |
| 7.15 | The generated `<ClassName>Config` alias's **`export` tracks the class's own**: an exported class (or `@mixin`) gets `export type <Name>Config`; a module-local class gets a non-exported `type <Name>Config` (so an internal class does not leak the alias, and a fully-internal class with no exported reference is elided from `.d.ts` entirely) — mirrors the mixin factory's `exportModifiersOf`; `export default` → non-exported alias | ✅ | `construction-config-alias-export.t.ts` |
| 7.14 | A construction consumer **or** a construction mixin applying several mixins that each override `initialize` with their own config does not hit a TS2320 merge conflict (the generated `$base` interface re-declares the `Base.initialize` protocol member when the class declares no own override); the merged config still requires every contributed field; the synthetic member does not crash editor rename/definition | ✅ | `source-transform-construction-config-alias.t.ts`, `tsserver-construction-config-alias.t.ts`, `source-transform-cross-file-construction.t.ts` |

## 8. Direct-`new` guard (this is compile-time only; runtime untouched)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 8.1 | `new Model()` on a mixin-less construction class → `TS2554` | ✅ | `emit-source-view-diagnostic-parity.t.ts` |
| 8.2 | `new Widget({…})` on a construction consumer → `TS2353` + descriptive message | ✅ | `emit-source-view-diagnostic-parity.t.ts`, `tsserver-diagnostics.t.ts` |
| 8.3 | Guard identical in emit (`tsc`) and source-view (`--noEmit`) modes | ✅ | `emit-source-view-diagnostic-parity.t.ts` |
| 8.4 | Guard surfaces in tsserver/IDE with the descriptive message | ✅ | `tsserver-diagnostics.t.ts` |
| 8.5 | Guard on a **transitive** subclass (`Consumer extends Base-descendant`, 1+ levels) | ✅ | `construction-deep-subclass.t.ts` (`@ts-expect-error new X()` at two depths), `construction-fill-missed-initializers.t.ts` |
| 8.6 | Static factory call (`Model.new(…)`) is **not** flagged | ✅ | `tsserver-diagnostics.t.ts` |
| 8.7 | Brand preserves assignability (`.mix`, `instanceof`, `AnyConstructor` slots) | ✅ | covered transitively by all construction + manual-mix fixtures staying green |

## 9. Construction constraints (unsupported by design)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 9.1 | A class that `extends Base` declaring its own constructor | ✅ | **Supported**: the constructor is preserved and runs as the native-construct step of `.new()`. A direct `new X()` stays a type error — enforced on the EMIT plane (the brand rides on the constructor's own parameter); source view leaves it un-banned, since poisoning the constructor there would shift the position-preserved body and break navigation. `source-transform-consumer-typecheck.t.ts`, `source-transform-mixins.t.ts`, `construction-mixin-standalone.t.ts` |

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
| 10.14 | Two **SAME-NAMED mixins from different files** consumed in one file: each consumer resolves and applies ITS OWN imported declaration (no first-name-wins collapse) | ✅ | `imported-mixin-resolution.t.ts` ("two SAME-NAMED mixins…") |
| 10.15 | Mixins across **circularly importing files** (a ⇄ b): the registry build neither loops nor drops either mixin; consumers on both sides resolve | ✅ | `imported-mixin-resolution.t.ts` ("CIRCULARLY importing files") |
| 10.16 | A **NodeNext (`type: module`) package** with `.js` relative specifiers: builds (emit/printed path preserves `impliedNodeFormat`), type-checks under `--noEmit`, runs; the rest of the suite is Bundler-only | ✅ | `emit-nodenext.t.ts`, `tsserver-incremental-rebuild-crash.t.ts` (editor plane) |
| 10.17 | A **QUALIFIED mixin reference** — namespace import (`import * as lib` + `implements lib.Logger`) or a local namespace member (`implements NS.Tagger`) — is NOT resolved (bare TS2420, consumer untransformed). Deferred: see TODO.md "Qualified mixin references" | ⏭️ | `imported-mixin-resolution.t.ts` (2× `xit`) |
| 10.18 | A **construction-base mixin imported through a re-export barrel** (§10.1c × §7): the consumer stays construction-enabled — `.new` carries the mixin's required config key through the barrel | ✅ | `construction-composition.t.ts` |

## 11. Diagnostics (custom, friendly messages)

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 11.1 | Invalid mixin: abstract / private / `#private` / abstract member (a constructor is allowed — see §9.1) | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.2 | Invalid mixin: missing type annotations (property/return/param/accessor) | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.3 | Anonymous default mixin / anonymous consumer rejected | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.4 | Dynamic consumer base expression (`extends makeBase()`) rejected | ✅ | `source-transform-diagnostics.t.ts`, `tsserver-diagnostics.t.ts` |
| 11.5 | Static member collisions (field strict / method strict-only / disabled) | ✅ | `source-transform-diagnostics.t.ts`, `type-errors.ts` |
| 11.6 | Contract violation (mixin body does not satisfy `implements`) | ✅ | `type-errors.ts`, `emit-contract-conformance.t.ts` |
| 11.7 | **Index signature** on a mixin is now **supported** (was rejected): copied into the generated interface (emit + source-view), erased at runtime; the consumer gains the dynamic member shape | ✅ | `fixture-suite/src/mixin-index-signature.t.ts` (runtime + emit + stress corpus; source-view via the "stay clean" sweep). See Resolved. |
| 11.8 | Index signature with a **generic value type** (`[key: string]: V`): a consumer fixing the parameter (`implements Bag<string>`) gains a string-valued dynamic shape; erased at runtime | ✅ | `fixture-suite/src/mixin-generic-index-signature.t.ts` |
| 11.9 | A **NUMERIC** index signature (`[index: number]: T`), not just the string one of §11.7/§11.8: copied into the generated interface so a consumer gains a number-indexed dynamic shape; erased at runtime (numeric keys read/write as plain own properties) | ✅ | `fixture-suite/src/mixin-numeric-index-signature.t.ts` |
| 11.10 | A `@mixin` class that `extends` another mixin is rejected (mixins compose via `implements`, not `extends`) — reported as a **NATIVE `ts.Diagnostic`** (code `TS990001`, our own message/span on the `extends` target), not a type-encoded `never` alias. Surfaces identically under `tsc`/CLI (imported-base branch) and in the IDE/source-view (same-file branch). First error on the native-diagnostic channel (`NativeMixinDiagnostic` sink → `wrapProgramDiagnostics`) | ✅ | `mixin-extends-mixin-diagnostic.t.ts`, `tsserver-diagnostics.t.ts` |

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
| 12.10 | **Completions**: `this.` members carry the mixin's members; the `.new({ … })` config object is a real member completion naming the config keys; module- and nested-scope identifier lists carry NO generated phantom names (`__X$base/$empty/$mixin` — filtered by the language-service plugin) | ✅ | `tsserver-completions.t.ts` |
| 12.11 | **Signature help** on the generated `.new(` names the `<Name>Config` alias; the **navigation tree** (outline) lists only real declarations; **outlining (folding) spans** respond over the transformed file | ✅ | `tsserver-editor-services.t.ts` |

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

## 15. Watch mode (real `tsc -w`)

End-to-end, driven through a genuine `tsc --watch` child process (not an in-process program like
§14's `stress-edit`): the program transform must be re-invoked on every incremental rebuild and
its per-program caches (facts, registry, import maps) must invalidate for the changed file, so
diagnostics stay correct across edits.

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 15.1 | A cross-file mixin edit breaks the consumer on the next rebuild and reverting clears it (the initial clean build already proves the transform ran — without it `implements Mixin` would not be satisfied); proves the transform re-runs each rebuild and facts/registry invalidate for the edited file | ✅ | `tsc-watch.t.ts` |
| 15.2 | Randomized break/revert round-trips: a minimal edit (delete/insert an identifier char, delete/insert a bracket) breaks compilation on rebuild and the verbatim revert returns to zero errors — over many seeded edits | ✅ | `stress-tsc-watch.t.ts` (seeded), shared driver `tsc-watch-util.ts` |

## 16. Nested-scope declarations (mixin / consumer in a function body or block)

A `@mixin` or a mixin consumer may be a named class declaration **anywhere a class can be
declared** — top level, a function body, or a plain block — not only top level. The generated
siblings are spliced into the SAME block (never hoisted to module scope); a nested class is a
local (cannot be exported, never leaks its name into the `.d.ts`). Works on emit AND source view
(the source-view path mutates the block in place — see AGENTS.md source-view invariant #12).

| # | Scenario | Status | Tests |
|---|----------|--------|-------|
| 16.1 | Consumer of a top-level mixin, declared inside a function body | ✅ | `nested-scope-declarations.t.ts`, `fixture-suite/src/nested-scope.t.ts` |
| 16.2 | `@mixin` declared inside a function body, consumed locally (consumer == mixin: both relax together) | ✅ | `nested-scope-declarations.t.ts`, `fixture-suite/src/nested-scope.t.ts` |
| 16.3 | Generated siblings land in the containing block, not module scope | ✅ | `nested-scope-declarations.t.ts` |
| 16.4 | Two same-named nested mixins in sibling scopes each expand from their OWN declaration (detection by node, not name) | ✅ | `nested-scope-declarations.t.ts`, `fixture-suite/src/nested-scope.t.ts` |
| 16.5 | A nested mixin SHADOWING a top-level name resolves to the nested one at the consumer; the top-level consumer keeps the top-level mixin | ✅ | `nested-scope-declarations.t.ts`, `fixture-suite/src/nested-scope.t.ts` |
| 16.6 | Consumer nested inside a plain block (not a function body) | ✅ | `fixture-suite/src/nested-scope.t.ts` |
| 16.7 | Nested CONSTRUCTION class (`extends Base`): generated `.new(...)` + `<Name>Config` alias in the same block; constructs through inherited `Base.new` (in-block alias keeps the §12.9 hover cosmetic) | ✅ | `nested-scope-declarations.t.ts`, `fixture-suite/src/nested-scope.t.ts` |
| 16.8 | Nested classes (and generated siblings) never leak NAMES into the `.d.ts`; an escaping nested instance widens to its structural shape | ✅ | `nested-scope-declarations.t.ts` |
| 16.9 | Source-view: nested classes navigate / quickinfo / diagnostics with no tsserver crash | ✅ | `fixture-suite/src/nested-scope.t.ts` (stress sweep) |
| 16.10 | A mixin / consumer **class expression** (`const C = class implements M {}`, anonymous or named) is rejected with a clean native diagnostic (TS990002 / TS990003), not a bare TS2420 | ✅ | `nested-scope-declarations.t.ts` |
| 16.11 | A consumer / mixin declared in a **`switch` case or default clause** (a statement list that is NOT a `Block`): splices into the clause's own list, both planes | ✅ | `nested-scope-declarations.t.ts` (M12/M12b), `fixture-suite/src/nested-scope.t.ts` |
| 16.12 | The remaining container kinds: a class **method body**, a **getter body**, an **arrow function body**, a **namespace** (ModuleBlock) | ✅ | `nested-scope-declarations.t.ts` (M13), `fixture-suite/src/nested-scope.t.ts` |
| 16.13 | Consumers declared inside a **`static {}` initialization block** (composing the splice with §1.18/§2.9) and in **try / catch / finally** blocks | ✅ | `fixture-suite/src/nested-scope.t.ts` |
