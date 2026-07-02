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

### ~~User decorators on a `@mixin` class (emit currently drops them)~~ — RESOLVED

Supported in BOTH decorator modes via the `decorate` callback argument of `defineMixinClass`
(applied INSIDE, before metadata attachment, so the DECORATED class is the mixin's runtime
identity — metadata, statics, `.mix`, linearization all live on what the user holds; the
undecorated canonical stays in `applications`, so consumer layers are never decorated). Standard
(TC39) mode passes `(__mixinValue) => { @dec class X extends (__mixinValue as unknown as
AnyConstructor) {} return X }` — a REAL decorated class declaration, so the COMPILER emits the
whole machinery (context/`Symbol.metadata`/`addInitializer`/replacement); the inner class is
type-erased and scoped, dodging the TS2310 interface-merge cycle and the TS2562 generic-base
wall. Legacy mode passes an `__applyLegacyClassDecorators__` fold (`dec(value) ?? value`,
bottom-up). Applied ONCE per value (§2.8's consumer parallel); decorator signatures are
type-checked on the source-view plane, where the decorators stay on the real class. Pinned by
`tests/mixin-class-decorators.t.ts` (order, addInitializer, replacement, nested scopes, legacy)
and `fixture-suite/src/mixin-class-decorator.t.ts` (dual-mode runtime + identity).

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

### Construction through a manual `.mix` heritage (`class X extends M.mix(BaseDescendant)`)

A class extending a manual mix over a `Base` descendant is not construction-recognized:
`isConstructionBaseOptIn` (`construction-config.ts`) bails on a non-Identifier extends
expression, so the class keeps the inherited `BaseDescendant.new` — the mixin's config fields
and the class's OWN fields never reach `.new`, and the return type stays the base. Pinned as
an `xit` test in `tests/construction-composition.t.ts`. Support needs: recognizing the manual
`.mix` call shape in construction detection (`hasManualMixinApplySyntax` already parses it for
typing), aggregating config from the base identifier AND the mixed mixin(s), and generating the
class's own `.new`/`<Name>Config` in both planes.

### Check: PARTIAL accessor overrides across the chain (suspected silent runtime traps)

JS prototype shadowing is per-NAME, not per-half: a nearer accessor descriptor replaces the
deeper one entirely. Suspected uncovered cases (each needs a test; the hazard does NOT depend
on define/set semantics, unlike §2.14):

- a consumer's GET-ONLY accessor over a mixin's full get/set pair — the mixin's SETTER dies
  (strict-mode TypeError on write through the mixin-typed view);
- a consumer's SET-ONLY accessor over a mixin's full pair — the GETTER dies (reads → undefined);
- the nastiest: "adding the missing half" — mixin declares `get x`, consumer adds only `set x`
  → the mixin's getter silently disappears while the merged TYPE looks like a full pair;
- the same three shapes mixin-vs-mixin within one `implements` list (first-listed = nearest);
- a half-override over a mixin's AUTO-ACCESSOR (`accessor x`).

The checker's own guards can't see any of this through the generated interface (same reason
as TS990010). If the tests confirm the traps, likely resolution: a new native diagnostic
(TS990011, "partial accessor override") — decide semantics by looking at the red tests.

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
when fixing. Likely resolution: rewrite the offending name in the diagnostic-wrapping channel
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

### Required-base statics inside a mixin's own static (`super.new` / `super.<baseStatic>`)

On the EMIT plane a mixin's static method cannot reach the required base's statics through
`super`: the factory's `base` parameter is typed bare `AnyConstructor<Base>` (instance side
only), so `super.new(...)` / `super.staticRequired()` inside a `static` body is TS2339 — while
the source-view plane (whose `$base` cast carries the base statics) accepts it: a plane
divergence. Affects a mixin's own `static new` factory wanting to delegate to `Base.new`
(workaround: build via `new ThisMixin()` — owning `static new` lifts the direct-`new` brand).
Fix would type the base parameter as `AnyConstructor<X> & Omit<typeof RequiredBase,
"prototype">` — a WIDE change (every mixin's static-side override checking against the base
kicks in), needs its own careful pass.

### `isolatedDeclarations` compatibility — the `tsc` layer

People enable the option without sharing its actual goal (external declaration emitters), and a
broken build is a broken build — so the `tsc` layer must work: a program with the transformer
and `isolatedDeclarations: true` should build cleanly. Suspected offender: the exported mixin
factory (`export const __X$mixin = function (base) { return class … }`) has an INFERRED return
type → TS9007-family error on the transformed tree; audit every generated export for explicit
annotations (value casts / interfaces / config aliases look fine already). Pin with a build
test first (emit + `--noEmit`).

Scope note: the FULL scenario of the option — generating `.d.ts` with an external no-typecheck
emitter (oxc etc.) — is out of reach BY DESIGN: an external emitter does not run ts-patch, so it
would emit declarations of the UNTRANSFORMED source (no interface, no `.mix`, no `.new`).
Declarations must come from the patched `tsc`; document that as a limitation.

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
