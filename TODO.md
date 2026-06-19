# TODO

Open transformer divergences found against real consumers (notably the `ts-serializable`
package). Not published — `package.json` `files` whitelists only `dist/src` + `README.md`.

The two transform paths (emit value-cast vs. source-view real class) are not type-
equivalent and stock TS gives one declaration only one face, so a few differences remain.
Full report: `COMPILER-VS-IDE-DIAGNOSTICS.md`.

---

## Heritage-clause navigation gap

go-to-def / find-all-references / quickinfo on a base type name *inside* a rewritten
`extends` / `implements` clause (e.g. `Base` in `class Consumer extends Base`, even when
`class Base` is local) resolve to the internal generated `$base`: refs/def come back empty,
quickinfo shows `any`, and `Base`'s own references omit the `extends Base` use. Source view
genuinely rewrites `extends Base` → `extends Consumer$base` and pins the generated `$base`
ref onto the source `Base` position, so no node there carries the real `Base` symbol — the
collapse trick can't fix it (the source base ref is *replaced*, and `.original` does not
redirect navigation, which goes by the node's symbol). A real fix is architectural (keep
source `extends Base` navigable while mixing members via interface merging — touches
runtime/construction). Characterized, not fixed. Compiler reports heritage base-name errors
at the *real* name, so emit is the correct path here. Guard: `tsserver-references.t.ts`
"navigation on a base type in a rewritten heritage clause is a KNOWN GAP" asserts the
current broken state so a future fix flips it red; `stress-references` tolerates these
empties. Documented in `AGENTS.md` invariant #9.

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
