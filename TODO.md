# ts-mixin-class — TODO

Future work. Each item is a known limitation or open question we treat as a future task.

- **Limitations** were moved out of the README's `Limitations` section (the README now keeps
  only short, user-facing notes). The technical reasoning lives here.
- **Open questions / discovered gaps** were moved out of `tests/USE-CASES.md`.

---

## To implement

### Watch-mode support (`tsc -w`)

Make the transformer work under TypeScript watch mode (`tsc --watch` / `-w`), not only a
one-shot `tsc` build. Watch mode rebuilds programs incrementally as files change: verify the
ProgramTransformer is invoked on each rebuild, the per-program caches (registry, facts,
import maps, source-view) invalidate correctly when a source file changes, and diagnostics
stay correct across edits.

**Test — end-to-end, real watch.** Model it on the current `stress-edit` test, but drive a
*real* `tsc` launched in watch mode (`-w`) over a fixture instead of an in-process program.
Steps: open a fixture under watch; apply random edits that introduce errors into the codebase
and assert the watch compiler reports them on each rebuild — ideally cross-checking that the
diagnostic matches what the IDE / language service produces for the same edit; then revert the
edits and assert the watch build returns to a clean, successful compile. It must use a genuine
watch-mode compiler process (real `tsc -w`), not a simulated/in-process one.

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


### Consider: mark required config keys with `!` instead of "required by default"

Today the convention is **required-in-config by default**, with `?` opting a field *out* (making
its key optional). Consider inverting the marker: a field's key is **required in the config only
when it carries `!`** after its name (`public name!: T`), the TypeScript definite-assignment
assertion.

Why `!` fits the semantics: TS reads `name!: T` as "this field is assigned somewhere TS can't
see, so don't require an initializer and don't raise `strictPropertyInitialization`". That is
*exactly* the truth for a required config key — the value is supplied by the config at
construction, not by an initializer. TS even **forbids** an initializer on a `!` field, which
matches "the value comes from the config." The transformer then strips the `!` from the emitted
property (just as it strips `?` in the rule above), leaving a clean `name: T`.

This is an alternative to the `?`-based convention above, so the two need to be reconciled:

- Decide what an **unmarked** field then means (a plain non-config property? an optional config
  key? — the default has to flip coherently), and how `?` (optional config key, mandatory
  initializer) coexists with `!` (required config key, no initializer).
- Weigh discoverability/ergonomics: "required is the default" vs "required is explicit via `!`",
  and which produces fewer surprises with `strictPropertyInitialization` on.

Pin the chosen convention with tests. Relates to the construction config alias (`<Class>Config`
/ `static new`) and the optional-config-field rule above.

### Always emit field initializers for stable object shape (opt-in)

In the generated code, every declared field of the classes the transformer produces (the
classes derived from the mixin base / consumers) should get an **explicit initializer**. If a
field has no initializer in the source, emit one (defaulting to `undefined` or `null`) so the
field is always assigned.

**Applies to every field, uniformly.** This does *not* depend on whether the field is a config
field or an ordinary property — both kinds are treated the same. Every declared field that has
no source initializer gets the fill value; there is no special-casing by field role.

**Why.** In JS engines (V8 et al.) it is a performance best practice to always initialize every
field. A field that is sometimes assigned and sometimes left unset makes instances of the same
class take on different hidden classes / object *shapes*; property access against a mix of shapes
degrades from monomorphic to **megamorphic**, defeating inline caches. Assigning every field
(in a consistent order) keeps one stable shape per class, so access stays monomorphic.

**Hidden behind a transformer option `fillMissedInitializersWith`.** This changes the emitted JS
(adds assignments), so the behavior is controlled by the `fillMissedInitializersWith` transformer
config option, which selects the fill value for missing initializers — three choices:

1. `"undefined"` — emit `field = undefined` for any field with no source initializer.
2. `"null"` — emit `field = null` instead.
3. off / none (the default) — do nothing; leave fields as written.

Note the interaction with the optional-config-field rule above: that rule governs the *type
contract* (when a `?` field is allowed and what its type is); this is purely an *emit*-level
guarantee that whatever the resolved field set is, each one is physically assigned in the output.
Pin the emitted shape with a test for each of the three option values.

### A `@mixin` class extending another mixin is a type error

A mixin must not `extends` another mixin — it consumes other mixins through the transformer
via `implements` (which builds the runtime chain). `extends` on a mixin is reserved for a
required (non-mixin) base class. So `@mixin class B extends A`, where `A` is itself a
registered mixin, should be reported as a **type error at compile time** (a custom
diagnostic in both emit and source view), not left to fail at runtime. Detect that the
`extends` target resolves to a known mixin and emit a clear "mix in via `implements`, do not
`extends` a mixin" diagnostic.

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

### 3. Consumers must be named top-level class declarations

The transformer inserts sibling declarations such as `__User$empty` and `__User$base`, then
rewrites the consumer to extend the generated base. Anonymous classes, class expressions,
and nested class declarations do not have a stable place where these helper declarations can
be emitted without changing runtime scoping or evaluation order, so they are rejected with
custom diagnostics.

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

## Known failing stress seeds

- **`stress-edit` throws on seed `2081798705` (sourceView).** Reproduce:
  `MIXIN_STRESS_SEED=2081798705 pnpm test` (test "transform survives randomized
  editor-like edits across the fixture corpus"). The transform **throws** (not a clean
  diagnostic) mid-edit with `Unsupported base class expression of a mixin consumer`. The
  failing edit chain ends on `manual-mix-dependency.t.ts` deleting chars at `@843`
  (`delete "p {\n "`), after edits to `empty-mixin.t.ts`, `default-mixin-consumer.t.ts`,
  `mixin-self-reference.t.ts`. Likely a transient mid-edit source state where a consumer's
  base expression parses as unsupported and the transform raises instead of degrading
  gracefully. Pre-existing (surfaced by a full unfiltered run); not yet investigated.

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
