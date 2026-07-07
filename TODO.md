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

### 1. Mixin members cannot be `private`, `protected`, `#private`, or `abstract`

A mixin is copied into generated inheritance positions and is also exposed structurally
through interfaces for consumers. TypeScript private/protected identity and ECMAScript
private fields are intentionally nominal and class-local, which makes them a poor fit for
this kind of composition. Use ordinary members inside mixins, or keep private state in a
non-mixin base class.

### 2. Mixin members need explicit type annotations

Mixin class properties, methods, accessors, and method parameters need explicit TypeScript
type annotations. The transformer has to generate interface members and declaration output
before relying on inferred implementation details. In ordinary classes TypeScript can infer
public member types from initializers and method bodies, but mixins need a stable AST-level
public surface that can be copied into generated declarations.

### 3. Dynamic consumer base expressions (`extends makeBase()`) are not supported yet

A dynamic base would need to be evaluated exactly once, stored in a generated runtime
constant, represented on both the instance and static sides, and emitted correctly in `.d.ts`
files. Use a named base class for now.

### 4. Base-name navigation — residual cases

Go-to-definition, find-all-references, rename and quickinfo on a base type name *inside* a
class heritage clause work for every well-typed consumer with an explicit entity-name base —
plain, generic, construction and qualified (`extends ns.Base`) alike, including the `<...>`
type arguments (see AGENTS.md "Heritage-clause navigation"). Still resolving to the internal
`$base`: consumers with no explicit `extends` (implicit required base), consumers with
diagnostic validations (broken code — `$base` positions those diagnostics), and a `@mixin`
class's own heritage. For those, navigate from the base class's own declaration instead.

### 4a. Qualified construction bases — residual cross-file forms

A LOCAL qualified base (`class W extends data.Model` where the namespace-nested `Model`
extends `Base`) is a full construction base: generated `static new`, `<Name>Config`,
cross-file subclassing of the consumer included. Not followed yet: a namespace-IMPORT base
(`import * as lib` → `extends lib.Model`), and a registry candidate whose local qualified
chain passes through an *imported* intermediate base (the construction-base registry
resolves qualified links with a file-local walk — see AGENTS.md construction invariant 7).
Such consumers construct manually; navigation works.

### 5. A mixin that violates its `implements` contract is flagged twice in the editor

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

- **Tree (incremental) config instead of the flat `Pick<Self, all-ancestor-names>`?** Today every
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
