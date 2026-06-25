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

### Zero run-time overhead for static case

**Precompute linearization statically to speed up (or eliminate) runtime C3.** The
transform already computes the C3 linearization at compile time (`linearization.ts`); the
runtime recomputes its own C3 merge again in `runtime.ts` on every mixin application.
Consider baking the precomputed order into the generated runtime so application is as fast
as possible — ideally the runtime just walks an already-linearized list (O(n), no merge)
instead of running `mergeC3Linearizations`. Look at what can be emitted (the resolved
dependency order per mixin/consumer) and whether the runtime can trust it and skip the C3
pass entirely, with a fallback for manually-applied (`.mix`) cases the transform can't see.

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
