# ts-mixin-class — TODO

Future work. Each item is a known limitation or open question we treat as a future task.

- **Limitations** were moved out of the README's `Limitations` section (the README now keeps
  only short, user-facing notes). The technical reasoning lives here.
- **Open questions / discovered gaps** were moved out of `tests/USE-CASES.md`.

---

## To implement

### Source map generation support

Check how the transformer behaves when TypeScript source map generation is enabled. Verify
that emitted JavaScript source maps still point at useful user-source locations after mixin
helper declarations, rewritten `extends` clauses, and generated runtime calls are inserted,
and document or fix any positions that become misleading.

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

### 3. Named mixin / consumer declarations at any nesting level — RESOLVED

A `@mixin` or a mixin consumer may be declared at the top level OR inside a function body /
block. The generated siblings (`__User$base`, the merged interface, the `defineMixinClass`
call, a construction `<Name>Config` alias) are spliced into the SAME block, never hoisted to
module scope. A nested class is a local: it cannot be exported, and never leaks its name into
the `.d.ts` (an escaping instance widens to its structural shape). Works on both planes — emit
(`tsc`) and source view (tsserver navigation / quickinfo / diagnostics).

Residuals:
- **Anonymous classes / class expressions** (`const C = class implements M {}`) stay
  unsupported — no stable statement slot for the siblings — but are now flagged with a clean
  native diagnostic (TS990002 for a `@mixin`, TS990003 for a consumer) instead of a bare TS2420.
- **Per-call runtime cost.** A nested mixin/consumer's `defineMixinClass` / chain assembly runs
  on every call of its enclosing function — no global registry leak (metadata rides on the
  fresh constructor), just not memoized across calls. Same as any class declared in a function.
- **Nested construction config-alias hover** keeps the §12.9 cosmetic (the alias name renders
  as `}` in the editor hover): its `<Name>Config` alias lives in the block, not appended past
  the document end where the name would read natively. Cosmetic only — `.new(...)` type-checks
  and constructs correctly.

### 4. Dynamic consumer base expressions (`extends makeBase()`) are not supported yet

A dynamic base would need to be evaluated exactly once, stored in a generated runtime
constant, represented on both the instance and static sides, and emitted correctly in `.d.ts`
files. Use a named base class for now.

### 5. Base-name navigation is limited for generic / construction / qualified consumers

Go-to-definition, find-all-references, and quickinfo on a base type name *inside* a class
heritage clause work for a **non-generic** consumer that does not use construction and extends
a plain (unqualified) base name (`extends Base` / `extends Base implements Mixin`): the
transformer keeps the real base on its source position, so navigation reaches the real type.

They still do **not** work for a **generic** consumer (`class Consumer<T> extends Base`), a
**construction-base** consumer, or a **qualified base** (`extends ns.Base`): in the IDE
"source view" the transformer rewrites those to `extends Consumer$base` and pins the generated
reference onto the source `Base` position, so clicking the base name resolves to the internal
generated base instead of the real type — references and go-to-definition come back empty and
quickinfo reports `any`. The class name itself, its type parameters, and its members navigate
correctly in every case. For the affected consumers, navigate from the base class's own
declaration or another usage instead.

### 6. A mixin that violates its `implements` contract is flagged twice in the editor

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
  - *Same root, worse symptom — find-all-references CRASHES the server.* Find-all-references on
    the generated `.mix` method itself (`Main.mix`) throws in tsserver
    (`Cannot read properties of undefined (reading 'members')`): computing the reference's
    definition display enters TS's node-reuse path
    (`writeType` → `visitExistingNodeTreeSymbols` → `tryVisitTypeReference` →
    `resolveEntityName` → `resolveNameHelper`), which resolves the synthetic `.mix` type's
    entity names against an enclosing scope — but the type is the deliberately scopeless
    `{-1,-1}` collapsed node, so name resolution reads `.members` of `undefined` and throws
    (TS is not defensive on this path). The only real fix is to remove entity-name references
    from the displayed type (structurally inline the dependency's members), which is risky and
    incomplete for cross-file/generic dependencies. **Deferred.** `stress-references.t.ts`
    tolerates this one documented `.mix` member-name site (and fails on any other crash); the
    exhaustive stress mode hits it every run, so it cannot silently regress further.
