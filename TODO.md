# TODO

Open transformer divergences found against real consumers (notably the `ts-serializable`
package). Not published — `package.json` `files` whitelists only `dist/src` + `README.md`.

The two transform paths (emit value-cast vs. source-view real class) are not type-
equivalent and stock TS gives one declaration only one face, so a few differences remain.
Full report: `COMPILER-VS-IDE-DIAGNOSTICS.md`.

---

## Heritage-clause navigation gap — residual (generic / construction consumers)

go-to-def / find-all-references / quickinfo on a base type name *inside* a rewritten
`extends` clause now resolves to the real base **for a well-typed, non-generic,
non-construction consumer**: the navigable-base fast path (`navigableConsumerBaseClassHeritage`)
re-extends the real base under a single-source cast (`extends (Base as unknown as
AnyConstructor<Base & …mixins> & <statics>)`), keeping the real `Base` identifier on its
source position. Guard: `tsserver-references.t.ts` "navigation on a base type in an extends
clause reaches the base class".

Still a gap for:

- **generic consumers** (`class Consumer<T> extends Base`): the instance members must thread
  `T`, which can only live on a generic base declaration the consumer extends — that is the
  `$base` interface. Putting `Base<T>` instances in the consumer's own base expression would
  trip TS2562; routing them through a merged `interface Consumer<T>` makes `super.<mixinMember>`
  miss them (the members land on `this`, not the base). So generic consumers keep `$base`.
- **construction-base consumers** (`isConstructionBaseOptIn`): their generated construction
  members and synthetic `super.initialize(...)` calls are wired against `$base`, so they keep it.
- consumers that emit diagnostic validations (unsatisfied required base, static collisions,
  missing runtime values) — only on broken code; `$base` carries those validations' diagnostics.

For all of the above the source `extends Base` is still rewritten to `extends Consumer$base`
with the `$base` ref pinned onto the source `Base` position, so the base name resolves to the
internal `$base` (refs/def empty, quickinfo `any`). `stress-references` tolerates these empties.
A full fix would need the generic/construction instance members to live on a base the consumer
extends while that base expression stays the real, navigable `Base`. Compiler reports heritage
base-name errors at the *real* name, so emit is the correct path here. Documented in `AGENTS.md`
invariant #9.

## Downstream-consumer contract coverage divergence

A `@mixin` class that does not satisfy the contract it `implements` is now flagged by `tsc`
on the *mixin declaration* (same TS2420 the IDE reports, same line and column — the
`implements` clause is carried on the factory's inner runtime class). What still differs:
when a *consumer* uses the mixin where the contract is expected, source view *also* reports
TS2741 at the consumer use-site while emit reports the violation only at the declaration.
This is **not** a tsc-green hole — the body is checked at the declaration, so a violation
never compiles either way; the difference is only that the editor additionally flags the
use sites (the value-cast value's type is the generated `interface X` that *inherited* the
contract members, so a consumer sees a type that structurally "has" them). Low severity,
documented in README "Limitations". The parity sweep tolerates these source-view-only lines
(`ideOnlyCoverageGaps`) — it only fails on emit-only lines, so this cannot make the parity
test red. Closing it would need the value-cast instance type to be the real body type rather
than the inherited interface.
