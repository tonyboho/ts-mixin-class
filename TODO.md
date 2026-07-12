# ts-mixin-class — TODO

Future work. Each item is a known limitation or open question we treat as a future task.

- **Limitations** were moved out of the README's `Limitations` section (the README now keeps
  only short, user-facing notes). The technical reasoning lives here.

---

## To implement

### `@ts-expect-error` cannot shield an erroring mixin heritage (investigated — full mechanism)

Found in pass 9, root-caused afterwards. A consumer with a constraint-violating mixin argument
(`class Broken implements Sorter<number>` where `Sorter<T extends Comparable<T>>`) is checked
TWICE by construction: the user's `implements Sorter<number>` is KEPT on the rewritten class
AND cloned into the generated `interface __Broken$base extends Sorter<number>` heritage — the
checker constraint-checks each type-reference NODE independently, so two genuine TS2344s exist.
The clone's check is REDUNDANT by construction (an identical reference — anything it reports is
also reported on the user's node). Normally invisible: both remap to the user's span and tsc's
output `sortAndDeduplicateDiagnostics` collapses them. `@ts-expect-error` exposes it, per plane:

- **emit, top level**: TS's comment-directive filtering runs INSIDE the transformed program, by
  REPRINTED-text geometry; the directive comment stays glued to the class line and shields only
  the class's own TS2344 — the `$base` clone (a different reprinted line) escapes, and only
  then is it remapped back onto the user's line for display. Result: red build, no TS2578.
- **emit, nested scope — BONUS BUG**: the reprint CLONES the leading comment trivia (including
  the directive) onto every spliced generated sibling — the reprinted text carries THREE
  `@ts-expect-error` copies, two shielding error-free generated lines. Result: a SPURIOUS
  TS2578 "unused directive" (remap-deduped to one) on top of the escaping TS2344 — a nested
  consumer gets the spurious TS2578 even when its directive legitimately matches.
- **source view**: the `$base` clone sits on a zero-width/collapsed generated range, so its
  TS2344 surfaces at an ARTIFACT position (e.g. the mixin's closing brace — the `'}'` family),
  which no user directive can reach.

Fix plan (dedupe-by-position alone is INSUFFICIENT — it never fixes the directives):
1. **Post-remap directive accounting at the `wrapProgramDiagnostics` seam**: after remapping to
   original coordinates, re-apply the ORIGINAL file's `commentDirectives` — drop shielded
   diagnostics, recompute used/unused ourselves, swallow the inner program's TS2578s and emit
   our own for genuinely unused directives. Fixes both emit shapes (incl. the spurious TS2578).
2. **Source view**: the seam filter can't reach the artifact-positioned clone diagnostic —
   either drop diagnostics sitting on zero-width GENERATED ranges (safe: `$base` content is a
   clone of user code, every real problem also fires on the user node), or pin the cloned
   heritage type-argument subtree to the user's heritage range (native filtering then works,
   but risks the navigation-hijack that motivated collapsing — stress arbitrates).
3. Independently useful: stop cloning leading comment trivia onto spliced generated statements
   (the nested-scope trivia duplication is a reprint-quality bug of its own).

Repro: the NOTE in `fixture-suite/src/mixin-type-level-generics.t.ts`; probe scripts from the
investigation live in the pass-9 session scratchpad.

### EPIC: config transport as PURE TYPE composition (designed 2026-07 — decisions locked, IN PROGRESS)

**Progress (2026-07-12):** pre-probes 1–3 done (results below). Decision 5 SHIPPED
(TS990015 name reservation, `_`-suffix machinery deleted — `reserved-config-names.t.ts`,
§7.13 flipped). Decision 2 SHIPPED (TS990016 default-export construction ban, §13.9
reversed incl. the registry read-side `"default"` aliasing —
`source-transform-cross-file-construction.t.ts`). Decision 4 SHIPPED (`<Name>ConfigMeta`
generation, §7.30 — `construction-config-meta.t.ts`; refinements: EXPORTED classes only
(a module-local companion is unimportable and a TS6196 under `noUnusedLocals`), fields
`requiresArgument`/`requiredKeys`/`keys`/`indexKinds`, the latter two per pre-probe 2's
overlap/index gates). Decision 1 stage 1 SHIPPED (SAME-FILE
composition — `source-transform-config-composition.t.ts`): a consumer/subclass/mixin
config references its LOCAL contributors' `<Name>Config<args>` aliases (top-level,
construction-enabled, no user `static new`, no reserved-name collision — everything else
flattens through facts as before); the Omit and the re-require are overlap-gated with
LITERAL subtractions (never `keyof`), a fully-overlapped alias layer drops entirely, and
the merged nearest-first fact list remains the single source for meta/requiredness/winner
representation. Decision 1 stage 2 SHIPPED (CROSS-FILE
alias-route): imported contributors with an importable `<Name>Config` (registry flags
`configAliasAvailable`/`generic`, `.d.ts` side detected by exported-alias presence) join
by a generated TYPE-ONLY import (`import type { XConfig as __X$config }` on the factory
import rails) — computed keys keep identity/requiredness across files (§10.25 flipped),
GENERIC `.d.ts` contributors instantiate at the use site (the known gap dissolved), and a
routed contributor skips its §13.8 value part. Named re-export barrels and transitive
generic dependencies keep the fact route (declaring-module + use-site-arguments gates).
A fully-overridden reference layer drops only when its fact inventory is COMPLETE (local,
no index signatures) — an imported alias may carry cargo facts cannot see. Next: the
legacy-transport deletion (decision 3's wholesale `.d.ts` shape change happens there) and
the `.d.ts` meta reader replacing the Pick-grammar reader.

**One mechanism, four wins:** (1) the config becomes a TREE — each level spells only its
own keys and references ancestors by alias, killing the O(D²) name re-flattening (the
instantiation-count quadratic; wall time was bench-neutral, the win is structural); (2) the
respelling/recovery machinery is DELETED — `transplantableConfigProperties` strips, the
`.d.ts` Pick-grammar reader, the value-route part and its registry plumbing; (3) EXOTIC
keys (computed/symbol/index) become native everywhere — no strip rule, no cross-file
asymmetry, because keys are never respelled at all; (4) GENERIC contributors are carried
natively (`BoxedConfig<string>` instantiates at the use site — the erosion gap below
dissolves).

Supersedes-in-plan: the value-route hybrid (§13.8), the fact respelling/strip rules
(§10.25's cross-file asymmetry), the `.d.ts` Pick-grammar recovery, and the
generic-contributor gap below. The "Tree (incremental) config" section further down studied
this family earlier and verdicted "keep flat" — that was a PERF verdict (tree ≈ flat), and
the blockers were the moving parts; the calculus changed: generated cross-module imports are
now shipped, battle-tested machinery (the required-base imports), and the motivation is
ARCHITECTURAL (delete the respelling/recovery layer, full exotic-key + generics support),
not speed.

**Decisions (locked with the user, 2026-07-11):**

1. **ALIAS-ROUTE ONLY.** Every contributor's config is referenced as its named generic
   alias, instantiated with the use-site arguments (`BoxedConfig<string>`) — full generics
   support, cheap for the checker (declared alias + args; no `Parameters<>` infer), and
   human-readable in hover. The value route (`NonNullable<Parameters<(typeof V)["new"]>[0]>`)
   is DELETED, not kept as a fallback.
2. **Default-exported construction values are BANNED** (a native TS9900xx diagnostic): their
   config alias cannot be exported (§7.15), which was the only structural hole in alias
   nameability. This REVERSES §13.9 (default-export construction-base support, added
   2026-07-11) — its test flips to expecting the diagnostic.
3. **No compatibility layer.** Pre-1.0: no `schemaVersion`, no dual-path reader; the `.d.ts`
   shape changes wholesale in one release.
4. **Residual facts ride a phantom metadata type** — `<Name>ConfigMeta`, an exported
   emit-plane-only alias of LITERAL fields (`{ readonly requiresArgument: true, readonly
   requiredKeys: … }`). Machine-readable by a trivial field/literal reader (replaces the
   Pick-grammar recovery AND the registry flags at package boundaries); also
   checker-addressable (literal types) if ever needed. Never appended in source view
   (`.d.ts` files are not transformed, so the meta only needs to exist in declaration
   emit). Coherence `meta ↔ config` is generator-asserted — pin it with a
   declaration-suite test.
5. **The `<ClassName>Config` (and `<ClassName>ConfigMeta`) names are RESERVED** — a user
   declaration colliding with the generated alias name is a native TS9900xx diagnostic,
   the `static mix` convention (§11.12) applied to the config namespace. This deletes the
   `_`-collision-suffix machinery (§7.13): the alias name is always DERIVABLE from the
   class name, so cross-file/alias-route resolution never needs name discovery.

**Composition shape.** Per consumer/subclass, nearest-first Omit chain + re-require —
GENERAL form below; per pre-probe 2 both the Omit and the re-require are emitted
OVERLAP-GATED (an overlap-free layer joins as a bare `& LayerConfig`):

    type ChildConfig<T> = Flatten<
        OwnPick
        & Omit<M1Config<args>, keyof OwnPick>
        & Omit<M2Config<args>, keyof OwnPick | keyof M1Config<args>>
        & …
    >  // & re-required: Required<Pick<…, DeepRequiredKeys & OverriddenKeys>>

- `keyof Own` is a TYPE expression — computed/symbol keys Omit without being spellable
  (§7.29 nearest-wins purely at type level).
- Omit drops the deeper layer's REQUIREDNESS for overridden keys, violating §7.28's
  monotonicity — the re-require step re-imposes it: required keys extract type-level
  (`{[K in keyof T]-?: {} extends Pick<T, K> ? never : K}[keyof T]`), or cheaper, come
  precomputed from `<Name>ConfigMeta.requiredKeys` (a stable literal union — no per-level
  mapped-filter work).
- Alias names resolve via the EXISTING generated-import machinery (`import type {
  BoxedConfig as __BoxedConfig__ } from "<spec>"` — same rails as the required-base
  imports, incl. pruning and collision-safe local names). The alias name is always
  `<ClassName>Config` — reserved by decision 5, so no discovery step exists.
- Same-PROGRAM cross-file contributors go alias-route too — §10.25's "deliberately
  omitted" strip rule dissolves.

**What gets deleted:** `transplantableConfigProperties` strips; the
`configPropertiesFromConstructionNewParam` grammar reader; the §13.8 value-route part and
its `configRequiresArgument` registry plumbing (folds into meta); the cross-file
`ConfigProperty[]` transport (shrinks to own-file facts + meta).

**Pre-probes — DONE (2026-07-12), results below; they REFINE the emission (same locked
decisions):**
1. ✅ Bare-tsc prototype (Omit chain + re-require over generic/exotic shapes): §7.29
   nearest-first types, §7.28 monotonic requiredness through nearer-optional redeclarations
   (own layer included), §7.24 exotic keys and use-site-instantiated generics ALL hold.
   One semantic trap found: `Omit<Deep, keyof Nearer>` where the NEARER layer has an INDEX
   SIGNATURE degrades every deeper concrete string/numeric key to `unknown` (`keyof`
   includes the index). Guard: an index-signature-free key set (`KnownKeys`-style `as`-filter,
   or the layer's key list from meta) — with it the composed type matches shipped semantics
   exactly (`string | undefined`, optionality preserved).
2. ✅ Bench (`bench:config-shape`, +3 shapes; 15 chains × depth sweep ×6 props, depth-32
   counters): **a naive per-level Omit chain is the quadratic it was meant to kill** — its
   `Exclude` distributes over the whole accumulated key union at every level: 141k
   instantiations vs flat's 1.9k (75×), assignability cache 26×, check 0.19→0.33s. Flatten
   per level is cheap and linear (6.7k). The always-on mapped-filter re-require
   (`RequiredKeysOf<Parent>` per level) is DISQUALIFIED (899ms vs 599ms wall at depth 32) —
   requiredness must come precomputed from meta. Consequences for the emission:
   - **Omit is OVERLAP-GATED**: emitted only where facts/meta prove a key overlap with a
     deeper layer (rare); an overlap-free layer contributes as a bare `& LayerConfig`.
     Common case ≈ tree-import + cheap flatten (linear instantiations).
   - **Re-require is overlap-gated too** (only when the overlapped deeper key is required
     and the nearer redeclaration is optional), with the key set from
     `<Name>ConfigMeta.requiredKeys` — never the mapped-filter idiom.
   - **Meta must also carry the layer's KEY LIST** (`keys`), so downstream transforms can
     compute overlap/index-signature gates for `.d.ts` layers at transform time (same-program
     layers use facts).
3. ✅ Elaboration naming: the flatten must stay the INLINE mapped type
   (`{ [K in keyof (…) ]: (…)[K] }`, today's idiom) — errors then speak `<Name>Config`
   (TS2345/TS2353 verified). A named `Flatten<T>` helper leaks the whole expansion into
   every message (aliasSymbol goes to the helper). Full hover arbitration remains with
   stress-quickinfo + the `tsserver-diagnostics` naming block once implemented.

**Test churn to expect:** every multi-part config text pin; §13.8/§13.9 rows and tests;
`.d.ts` fixture snapshots; the declaration-suite gains the meta-coherence pin.

### Phantom "ancestors-only" interfaces to flatten the required-base checker cost (idea, 2026-07)

**The problem.** The `requiredBase` compile-bench scenario (mixins `extends Base_k` over deep
compatible-base chains, `pnpm bench`, sizes via `TS_MIXIN_BENCH_REQUIRED_BASE_SIZES`) grows
super-quadratically: delta over the plain corpus ≈ +25ms@30, +120ms@80, +0.5s@160, +3.2s@320.
CPU profiling attributed the cost to the CHECKER re-elaborating base chains, not to our
resolver (~6ms of the 3.2s delta) — see the perf note in AGENTS.md and the upstream
instantiation-depth issue microsoft/TypeScript#63555.

**The rejected fix (kept for contrast).** Typing the factory's `base` parameter through the
mixin's own generated interface cut ~25% off the bench but was rejected as a correctness
regression: the mixin's OWN members land in the base type, so `super.<ownMember>` inside the
mixin body falsely typechecks.

**The idea.** We already accompany classes with generated type-level metadata — the
`<Name>Config` alias is exactly that, and it survives all three planes (emit/.d.ts via the
registry declaration file; source view via the append-as-real-text machinery, invariant 10a;
fixture/stress). Apply the same move to the base typing: generate a PHANTOM declared
interface per mixin that represents the "ancestors-only" surface —

```ts
interface Logger$base extends Base_3, Dep1 {}   // required base + dependencies, NO own members
```

— and reference it wherever we currently build that surface as an anonymous computed type.
Because the phantom contains only ancestors (exactly what `AnyConstructor<Req & Dep1 & Dep2>`
carries today), `super.<ownMember>` stays a type error — the rejection reason for the earlier
fix does not apply.

**Why it should help — the checker's relation cache IS the "transitive pairwise cache".**
The checker caches assignability results keyed by type-ID pairs and resolves a declared
interface's inherited members once under a stable ID. That cache only pays off when both
sides of a comparison are stable declared types; today we feed it fresh anonymous types in
three places, defeating it:

1. **The factory `base` parameter** (`createBaseParameter`, `src/mixin-factory.ts`):
   `AnyConstructor<Req & Dep> & ClassStatics<typeof Req> & Omit<ClassStatics<typeof Dep>,
   "mix" | keyof RuntimeMixinClass>` — every `Omit`/`ClassStatics`/intersection is a fresh
   instantiation per mixin.
2. **The consumer's runtime-chain cast** (`createConsumerBaseCastType`,
   `src/consumer-base-heritage.ts`): `typeof Base & Omit<typeof M1, "prototype" | "new" |
   "mix"> & …` — a fresh anonymous intersection per consumer.
3. **The validation type arguments** — the pairwise "factual base is compatible with the
   required base" checks.

A phantom interface resolves the deep chain once and turns the pairwise comparisons into
relation-cache hits. Bonus: an interface extending a CLASS inherits even its
private/protected nominal brand, so base compatibility is preserved more faithfully than
through the structural `Omit` bags.

**Honest caveats.**

- *The hot site is unproven.* The profile blamed "checker re-elaborating base chains" but the
  exact dominating instantiation site was not pinned. If the cost sits in resolving the
  consumer's `$base` interface extends (already declared), phantoms on the factory parameter
  buy nothing.
- *Generics eat the win.* A generic required base / generic mixin forces a generic phantom →
  every instantiation is a fresh type ID again. The win is real only for non-generic chains
  (which IS the bench scenario, but the boundary must be documented).
- *Interface-extends restrictions.* `Omit<X, "a">` is legal in an extends clause; mapped /
  conditional shapes (`ClassStatics<…>`) can hit TS2312 ("an interface can only extend an
  object type … with statically known members"). The phantom may end up instance-side only,
  with the statics tail remaining an intersection — a partial win.
- *Visible surface grows.* Extra names in `.d.ts` and in hover/quickinfo (the base starts
  displaying as `Logger$base` instead of the expanded chain) — stress-quickinfo will notice;
  this is a user-visible display change, not just internals.
- *Three planes.* Every phantom must hold in emit/.d.ts, source view (more appended real
  text), and fixture/stress — the Config-alias machinery is the template.

**Validation plan (cheap falsification FIRST, no src changes).** Teach the bench generator to
emit fixtures in the phantom form BY HAND — the way the transform would — and run the
`requiredBase` scenario at 30/80/160/320. If the super-quadratic curve flattens, the idea is
confirmed and worth transplanting into the transform; if not, one bench run settled it. A CPU
profile on the phantom fixture also shows where the cost actually moved.

### Real-fixture declaration-time benchmark (mixins vs plain classes)

Measure the actual load-time cost the mixin runtime adds over plain TypeScript classes, on a
realistically large program. Generate a fixture of N mixin classes (N = 100, 500, 1000) where
each mixin has exactly ONE ancestor (a single-parent chain — the simplest, most common shape,
isolating per-class registration cost from C3 merge cost). Compile it through the transformer,
then measure the **initialization time**: how long it takes for ALL classes to be declared when
the emitted module is first loaded (every `defineMixinClass(...)` / chain assembly runs at
module-eval time).

Generate an **identical structure with ordinary TypeScript classes** (plain `extends` chains,
no `@mixin`) and measure the same initialization time. Report the delta across the three sizes
so the per-class overhead and how it scales are both visible. Run it in the `replay` mode
(production: `TS_MIXIN_VERIFY_LINEARIZATION=0`) so the number reflects the shipped fast path,
not the dev-time cross-check. (Complements `bench/c3`, which times the linearization step on
abstract integer graphs; this times real emitted classes end to end.)

---

## Limitations (future tasks)

### 1. Mixin members cannot be `private`, `protected`, `#private`, or `abstract` (explored — tiered support is feasible)

A mixin is copied into generated inheritance positions and is also exposed structurally
through interfaces for consumers. TypeScript private/protected identity and ECMAScript
private fields are intentionally nominal and class-local, which makes them a poor fit for
this kind of composition. Use ordinary members inside mixins, or keep private state in a
non-mixin base class.

**Explored 2026-07-07** (every claim below verified by `scripts/exploration-private-modifiers.ts`
against our actual generated shapes — omitting interface + factory class for emit, claiming
cast for source view — on the pinned TS; type-level `@ts-expect-error` and runtime chains both
checked; the probe compiles with the repo build, so the pinned mechanics stay verified):

- **`#private` — the most supportable, tier 1.** The `#` member is not part of the public
  type surface at all, so the generated interface simply OMITS it; the emit factory class
  declares and uses it (runtime chain verified, the member works through `this.#x` inside
  mixin methods); the source-view consumer cast claiming the branded class type typechecks,
  `implements <mixin with #x>` included. This is also the officially blessed workaround in
  TS's own mixin docs. One real semantic trap to document: each factory APPLICATION declares
  a fresh class → a fresh `#x` brand per consumer chain, so a mixin method touching `#x` on
  an instance from ANOTHER consumer's chain (cross-instance access, `obj.#x` / `#x in obj`)
  throws at runtime — brands are per-application, not per-mixin. Same-instance access (the
  overwhelmingly common case) is always fine.
- **`protected` / `private` as "mixin-internal" hidden members — tier 2.** Same omission
  modeling: the interface leaves them out, the factory class keeps the modifier, the claiming
  cast typechecks (`implements` accepts a class with private/protected members when the
  heritage claims that class's type; external access stays banned). The semantics honestly
  become "mixin-internal": a consumer/subclass cannot see or override the member (it is not
  on the surface), so `protected` degrades to `private`-for-the-mixin. Verified danger that
  makes a NEW diagnostic a prerequisite: a consumer can silently redeclare the invisible name
  as its own (even incompatibly typed) public member — no type error, silent runtime
  collision. The transform must statically check hidden names against the consumer's own
  members and every co-applied mixin's members (the member-walk machinery exists —
  `collectClassMemberFacts`); the construction config already excludes non-public members,
  so `<Name>Config` stays correct for free.
- **`abstract` — feasible, tier 3 (largest surface).** The factory can declare an `abstract
  class` (legal as a DECLARATION inside the factory function; class expressions cannot be
  abstract — our factory already uses a declaration), typed outward via TS 4.2 abstract
  construct signatures. Abstractness does NOT survive a construct-signature cast (the
  signature erases which members are abstract), but re-declaring the abstract members on the
  generated `$base` class (declared `abstract`, never instantiated directly) forces the
  concrete consumer to implement them — verified: the lazy consumer errors, the implementing
  one compiles and runs. Consequences: abstract-mixin consumers must keep the `$base` pair
  (the navigable fast path's cast cannot carry abstractness) or accept emit-only enforcement;
  interplay with construction (`.new` must stay banned on the abstract mixin itself, allowed
  on concrete consumers) needs design.
- **Rejected routes:** literal `private`/`protected` on interface members (grammar-banned);
  the `interface extends class` nominal trick (verified working in isolation — unrelated
  implementers rejected — but unusable here: the mixin class is erased in emit and its name
  is taken by the const value, so there is no class type left for the interface to extend
  without a duplicate-identifier identity rework).

### 2. Dynamic consumer base expressions (`extends makeBase()`) are not supported yet

A dynamic base would need to be evaluated exactly once, stored in a generated runtime
constant, represented on both the instance and static sides, and emitted correctly in `.d.ts`
files. Use a named base class for now.

### 3. A mixin that violates its `implements` contract is flagged twice in the editor

When a mixin does not satisfy its `implements` contract, the editor (and `tsc --noEmit`)
reports the error twice — once on the mixin declaration and once at each *use site* where the
contract is expected — while `tsc` (a normal emit build) reports it only on the mixin
declaration. Both fail the build on the same root cause; the difference is only that the editor
additionally flags the consumer use sites. This is because the emit path models a mixin's
public surface as a generated `interface X extends Contract`, which *inherits* the contract's
members, so a value typed as `X` looks like it satisfies the contract at a consumer even when
the runtime body does not — but the body itself is still checked at the declaration (`class
extends base implements Contract`), so a missing or mismatched member never compiles. In short:
`tsc` never passes a contract violation silently; it just points at the declaration rather than
also at every consumer.

---

## To reconsider

- **Is the `instance.initialize(props) ?? instance` fallback in `Base.new` (`base.ts`)
  needed?** `initialize` is declared `: void`, so in well-typed code the left side is always
  `undefined` and `?? instance` always takes the right branch — the `??` only matters as an
  undocumented escape hatch letting an override return a *replacement* object. The runtime
  cost is negligible (one nullish check per construction, not a hot path), so this is about
  intent/clarity, not performance: decide whether that escape hatch is intended (keep and
  document it) or not (simplify to `instance.initialize(props); return instance`). Behavior
  of `Base.new` is covered by tests, so changing it touches them.

- Assign properties in the order they are declared? Can be done in the native constructor,
  but requires an extra check for every optional property. Can also be done in the special
  method like `configure` as an extra step (will replace `Object.assign()` in the `initialize`)
  - **Direct per-property assignment in the native constructor.** Instead of
    `Object.assign(this, config)` in `initialize`, generate the assignments explicitly, in
    declaration order: `this.a = config.a; this.b = config.b; …` straight in the native
    constructor. The compiler already inserts each field's *initializer* assignment first
    (initializers run before any config is applied), so the generated config assignments simply
    follow them in the same constructor body — possibly worth merging the two, but at minimum
    they coexist fine. Reuses the existing machinery (the same property-collection / fill
    functions). Optional keys still need the per-property guard noted above: a bare
    `this.x = config.x` would clobber an initialized default with `undefined` when the key is
    absent from the config.
    - *Trade-off — fragile but maximally performant.* Assignment now happens piecemeal, so the
      instance is observably half-initialized between steps: a property with a side effect (a
      settable accessor / setter) fires while later properties are still unset. The upside is
      that one explicit, statically-known assignment list is the fastest possible shape — no
      config-object iteration, monomorphic writes — at the cost of that fragility.
    - *Maybe a separate opt-in base.* This could live behind an alternative base (e.g. `Base2`)
      tuned specifically for this instantiation shape — fast but knowingly fragile — rather than
      changing the default `Base` contract.

- **Tree (incremental) config instead of the flat `Pick<Self, all-ancestor-names>`?**
  *Superseded in plan (2026-07): the pure-type-composition EPIC under "To implement" IS the
  tree form — alias-route references with a nearest-first Omit chain, flat at every
  observation point through the flatten wrapper. The "keep flat" verdict below was a PERF
  verdict (tree ≈ flat); the epic's motivation is architectural. Kept for the benchmark
  data and the variant analysis.* Today every
  construction class emits its config as one flat `Pick<Self, "n1" | … | "nN">` over its own
  instance type, where the name union is the *recursively accumulated* set (own + the whole
  `extends` chain + mixins + transitive mixin deps). This scales **perfectly by width** but
  **super-linearly by depth**: each level in a chain re-flattens *all* ancestor names, so the
  total config member-work over a depth-`D` chain is `P·(1+2+…+D)` = **O(D²)**.
  - *Measured.* 100 classes × {10,50,100} flat props → check `0.09→0.10→0.14s`, ~3 instantiations
    per extra property (linear, trivial). Depth chains (50 leaves, 5 props/level) at accumulated
    {25,50,100} → check `0.12→0.18→0.39s`, instantiations `18.9k→63.4k→227k` (≈O(D²)). Absolute
    cost is still small (a depth-20 / 100-prop hierarchy ≈ 8 ms check), so this is a "if deep
    config hierarchies ever get hot" optimization, not urgent.
  - *The fix.* Make each level reference the parent/mixin config by name instead of re-expanding:
    `type ChildConfig = Pick<Self, own-names> & <base config> & <each mixin config>` → each level is
    O(own), the chain O(D).
  - *Referencing the parent config WITHOUT a phantom import.* The base and mixins are already in
    scope as **values** (imported for `extends` / runtime), so derive the config from the value:
    `NonNullable<Parameters<typeof Base.new>[0]>` (the `NonNullable` strips the `| undefined` an
    optional `new` param adds). Verified: it resolves to exactly the base config — required /
    optional / excess-key / wrong-type all check correctly. This avoids generating imports, avoids
    the `export default` gap (a default-exported class has a **non-exported** `<Name>Config` per
    §7.15, but `typeof DefaultBase.new` still works through the value), and adds no synthetic
    `import` node to position in source view.
  - *Phantom imports are also possible* (the transform already generates imports; module specifiers
    are tracked in `baseImportMap.resolvedFileName`), i.e. `import type { BaseConfig } from "<spec>"`
    — but heavier (collision/aliasing, the default-export gap, a synthetic import to range in source
    view).
  - *Generics are the catch (for the value route).* `Parameters<typeof Base.new>[0]` cannot thread a
    child's type argument into a generic base's config (`class Child<U> extends Base<U>` wants
    `BaseConfig<U>`, but the value route gives the uninstantiated form). Generic bases would need the
    **imported** `BaseConfig<U>`, or stay flat (`Pick<Child<U>, names>` threads `U` itself).
  - ***Best variant — a symbol-keyed config carrier on the INSTANCE type.*** Brand each construction
    class's instance type (via the generated interface / declaration merging — type-only, no runtime,
    no init) with a phantom member under one shared package-level `unique symbol`:
    `interface X<T> { readonly [CFG]: <its config> }`. Then reference the config by indexed access:
    `type ChildCfg<U> = Pick<Child<U>, own-names> & Base<U>[typeof CFG] & Mixin<U>[typeof CFG]`.
    **Verified** (clean typecheck, all `@ts-expect-error` fired): `Base<U>[typeof CFG]` **threads the
    type argument** (the instance type is already parameterized — solving the generic catch above), a
    string-name `Pick` does **not** pick up the symbol key (no config recursion), and the tree
    composition is generic-correct. Advantages over both other routes: threads generics with **no**
    per-config imports (one shared symbol, exported like `Base`, written only by the generator — users
    keep referencing the named `<Name>Config` alias), no `NonNullable`, and cross-file it rides in the
    `.d.ts` with the instance type (a library-exported `unique symbol` keeps identity across files).
  - ***Benchmarked*** (`bench:config-shape`, 30 chains × depth 12 × 8 props = 96 accumulated), check
    time: `baseline` 60ms / `flat` 90ms / `tree-import` 80ms / **`tree-symbol` 170ms** (instance
    carrier — ~1.9× flat, Assignability cache size ~5×) / **`tree-static-symbol` 120ms** (static
    carrier). The instance `[CFG]` is the expensive one: it lives on the **instance** type, so it is
    dragged into every structural instance comparison (upcasts, passing instances to typed params).
  - *A symbol carrier on the STATIC side dodges most of that* (`tree-static-symbol`, 170→120ms):
    `class X { declare static readonly [CFG]: <config> }`, config = `(typeof X)[typeof CFG]` — off the
    instance, so instance comparisons don't touch it. **But** (a) a static member **cannot reference
    class type parameters** (`static [CFG]: Cfg<T>` → **TS2302**), so the static carrier can't carry
    generics either (same hole as `Parameters<>`); and (b) it is still pricier than `flat`/`tree-import`
    because each level's static `[CFG]` (`= parent[CFG] & {own}`) is checked against the inherited one
    as a static-member override down the chain. So it beats the instance carrier but does **not** beat
    `tree-import`.
  - ***Depth sweep — `flat` vs `tree-import` is a wash*** (`bench:config-shape` sweeps depth 4,8,16,32;
    a deeper 8,16,32,64 run isolates it). The deep hierarchy + the upcast workload is ITSELF ~O(D²)
    (baseline check climbs 30→40→80→**340ms** over depth 8→64 — D upcasts × O(D) members per leaf), and
    `flat` and `tree-import` add only a small, near-equal increment on top (≈ +60ms each at depth 64).
    So `flat`'s O(D²) config cost — real in the **Instantiations** count — is **swamped** in wall/check
    time by the inherent quadratic of deep classes + instance comparisons. `tree-import` does **not**
    meaningfully pull ahead. The symbol carriers are the only shapes that move the needle, and the
    wrong way (`tree-symbol` reaches ~490ms at depth 32 vs flat 180 — `[CFG]` rides inside every
    already-quadratic comparison).
  - *Realistic plan (post-benchmark).* **Keep `flat`.** The benchmark says the config representation
    barely matters between `flat` and `tree-import` (both dominated by the hierarchy's own cost), so the
    O(D²)→O(D) rewrite buys no measurable win — not worth its moving parts (intersection → reopens the
    nested-diagnostic naming, needs the flatten wrapper; `.new`/config only on `Base`-derived
    contributors; generics special-case). Revisit only if a future profile shows config-type resolution
    (not the surrounding hierarchy) actually dominating. The symbol carriers are off the table for
    perf: instance costs ~2×, static loses generics (TS2302).
