# ts-mixin-class — TODO

Future work. Each item is a known limitation or open question we treat as a future task.

- **Limitations** were moved out of the README's `Limitations` section (the README now keeps
  only short, user-facing notes). The technical reasoning lives here.

---

## To implement

### Source map generation support

Check how the transformer behaves when TypeScript source map generation is enabled. Verify
that emitted JavaScript source maps still point at useful user-source locations after mixin
helper declarations, rewritten `extends` clauses, and generated runtime calls are inserted,
and document or fix any positions that become misleading.

### Qualified mixin references (`implements lib.Logger` / `implements NS.Tagger`)

A consumer referencing a mixin through a QUALIFIED name is not resolved — the consumer is left
untransformed and fails with a bare TS2420. Two forms, both pinned as `xit` tests in
`tests/imported-mixin-resolution.t.ts`:

- a namespace import: `import * as lib from "./logger"` + `class C implements lib.Logger`
- a local namespace member: `namespace NS { @mixin() export class Tagger }` + `implements NS.Tagger`

Resolution keys heritage references by identifier text (`byLocalName`), so a
`PropertyAccessExpression` reference never matches. Supporting it needs: facts collection for
qualified heritage expressions, registry lookup through the checker's alias chain (similar to
`addReExportAliasKeys`), and both planes' emission (`lib.Logger` as the chain value expression
and in the generated `$base` interface heritage). Alternative fallback if support stays out:
a native diagnostic ("qualified mixin reference is not supported — import the mixin by name").

### ~~Check: `override` modifier on a mixin member overriding its DEPENDENCY's member~~ — RESOLVED (pass 8)

Answered and pinned in `compiler-option-edges.t.ts` (§2.23): the modifier IS legal in both
planes, on a consumer AND on a mixin over its dependency, in the default config and under
`noImplicitOverride` (which — spec decision — extends to mixin-member overrides: unmarked →
TS4114, marked → clean). No rewrite/strip needed; the remaining piece is the message's
base-NAME cosmetics (previous section).

### Generated base names leak into CHECKER diagnostic messages (found via `noImplicitOverride`)

The checker names the base class in several of its own messages, and after the transform that
name is a generated artifact, not what the user wrote. Minimal repro (`noImplicitOverride:
true` in the compiler options):

```ts
import { mixin } from "ts-mixin-class"

@mixin()
class Greeter {
    greet(): string { return "hi" }
}

class Worker implements Greeter {
    greet(): string { return "hello" }   // ← the un-marked override
}
```

- expected message: `…overrides a member in the base class 'Greeter'` (the mixin whose member
  is overridden — the only base-ish name that exists in the user's source);
- actual, emit plane (`tsc`): `…in the base class '__Worker$base'`;
- actual, source view (`tsc --noEmit` / IDE): `…in the base class '}'`.

And with a REAL base (`class Robot extends Machine implements Greeter` overriding `Machine`'s
member): expected `'Machine'`, actual `'__Robot$base'` (emit) / `'Machine & Greeter'` (source
view). Pass-8 probes; the code path is pinned in `compiler-option-edges.t.ts` (which asserts
only the TS4114 code, not the message — tighten those pins when fixing this).

- **emit plane**: the base renders as the synthetic heritage — `'__Worker$base'`,
  `'__Robot$base'` — even when the user's class has a REAL base (`class Robot extends Machine`
  → the message should say `'Machine'`);
- **source view**: worse — the `$base` interface's collapsed zero-width range makes the name
  render as `'}'` (the character at the collapsed position), or as the intersection text
  `'Machine & Greeter'`.

The diagnostic is correct in substance (the member IS an override); only the NAME is wrong. Any
other checker message that embeds the base-class name presumably leaks the same way (TS2415
"incorrectly extends", TS2417 static-side, TS4113/4117 override family, …) — sweep for them
when fixing.

**TS2417 (static-side extends) — confirmed leak, repro on BOTH planes** (the check fires on
emit since the factory's base parameter carries the base statics — the `super.<baseStatic>`
work). `class Req { static tag: string = "r" }` + `@mixin() class Marked extends Req { static
tag: number = 1 }`:

- emit: `Class static side 'typeof __Marked$class' incorrectly extends base class static side
  'ClassStatics<typeof Req>'` — BOTH names are generated artifacts (the factory's inner runtime
  class; the factory parameter's statics constituent). Expected: `'typeof Marked'` / `'typeof Req'`.
- source view: `Class static side 'typeof Marked' incorrectly extends base class static side
  'typeof }'` — the class side is right, the base renders as the collapsed-cast `'}'` again.

The code path is pinned in `mixin-static-super.t.ts` ("INCOMPATIBLE static override…" asserts
only the TS2417 code, not the message — tighten those pins when fixing this). Likely resolution: rewrite the offending name in the diagnostic-wrapping channel
(`wrapProgramDiagnostics` already intercepts program diagnostics) — map a generated heritage
name (`__X$base`/`$empty`, the factory intersection text, the collapsed-range render) back to
the user's own base name (or the mixin's name for a mixin-contributed layer). Needs a message
REWRITE (string surgery on `messageText`), not just a span fix, so keep it conservative:
substitute only exact generated-name matches.

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

### Construction MIXIN with a parameter property: the config alias is `Pick<X, never>` (latent)

Found while annotating the factory under `isolatedDeclarations`: for `@mixin() class Tagged
extends Base { constructor(public tag: string = "…") {…} }` the generated
`TaggedConfig = Partial<Pick<Tagged, never>>` — the parameter property never reaches the
mixin's own config keys (the alias key list is EMPTY). Nobody noticed because (a) an
all-optional EMPTY object type accepts any object literal, so `.new({ tag: "x" })` still
compiles (with no excess-key or required-key checking), and (b) the pin in
`construction-mixin-config-shapes.t.ts` ("a public PARAMETER PROPERTY … is a config key")
matches `tag?: string` in the `.d.ts` — which comes from the factory's INFERRED constructor
signature text, not from the config. Construction CLASSES handle parameter properties
correctly (`construction-parameter-property.t.ts`); only the construction-MIXIN config
collection misses them. Fix: trace where the mixin's own `configProperties` skip constructor
parameter properties, then tighten the pin to assert the CONFIG shape (not `.d.ts` text).

### Upstream: report the interface-accessor `this` crash (TypeScript 6.0 regression)

Plain TS — no transform involved: `interface I { get self(): this }` crashes the checker with
`TypeError: Cannot read properties of undefined (reading 'flags')` in
`getConditionalFlowTypeOfType` (via `getAnnotatedAccessorType`; `getTypeFromTypeNodeWorker`
returns undefined for the `this` node). Any `this` nested inside the accessor's annotation
triggers it (`get pair(): [this, string]` too); a method or property signature with the same
`this` type is fine. Verified: **5.9.3 clean; 6.0.3 (our pin) and nightly 6.0.0-dev.20260416
crash** — a 6.0 regression, unfixed upstream as of 2026-07. File a TypeScript issue with the
one-line repro. Our side is defended: the generated mixin interface falls back to a PROPERTY
signature for this-typed accessors (`containsThisType` in `interface-members.ts`, pinned by
`mixin-accessor-edges.t.ts`); remove the fallback once the fix ships in the pinned TS.

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
