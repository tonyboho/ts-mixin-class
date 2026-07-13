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
