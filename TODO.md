# TODO

Open transformer bugs found against real consumers (notably the `ts-serializable`
package). Not published — `package.json` `files` whitelists only `dist/src` + `README.md`.

---

## Emit / source-view diagnostic position parity (`stress-diagnostic-parity`)

The corpus sweep (rename a random AST identifier → inject a real error, compare emit vs
source-view diagnostic *lines*) now passes: **emit never reports a diagnostic on a line
the source has no error on.** Goal had been "lines first, then columns."

1. **Generated transformer diagnostics now remap correctly.** ✅ A transformer-emitted
   diagnostic (e.g. the `Invalid mixin class declaration` validation alias, TS2344) sits
   on a *generated* node whose reprinted line collapses many printed columns onto one
   source column. The remap now binary-searches the nearest preceding source-map entry
   (line-accurate even on fully-generated lines) and caps the column advance at the next
   entry on the same source line (so a long alias no longer overshoots onto the next
   source line). Was `8:1` vs `7:5`; now both `7:5`.

2. **Column parity.** ✅ The stress sweep now also asserts columns: for a diagnostic both
   trees report (matched on `file:line:code:message`, so two different errors sharing a
   line+code are not conflated), the remapped emit column equals the source-view column. A
   filtered audit over all 1273 non-heritage/non-base perturbations found **0 column
   mismatches**. Full breakdown of compiler-vs-IDE diagnostic differences:
   `COMPILER-VS-IDE-DIAGNOSTICS.md`.

### Known dual-tree divergences (not line-remap issues — out of scope for the remap)

Full report: `COMPILER-VS-IDE-DIAGNOSTICS.md`. These are pre-existing differences in
*what* the value-cast (emit) and real-class (ide) trees check, surfaced by the sweep and
deliberately excluded from the parity assertion:

- **Coverage gap — emit under-reports mixin-contract errors.** Renaming a mixin member
  (e.g. `contractMethod`) makes the source-view tree flag consumers (TS2741/TS2551/
  TS2420) while emit reports *nothing*. So `tsc` can pass while the IDE shows real
  errors. This is the "different sources" risk: the two trees are not type-equivalent for
  mixin member contracts. Fixing it means making the value-cast emit model type-check
  like source view — a large, separate effort. The sweep tolerates source-view-only lines
  and counts them.
- **Heritage-navigation gap** (already tracked below): source view reports `extends`/
  `implements` base-name errors at a synthetic `$base` position; emit reports them at the
  real base name (emit is the *correct* one here). The sweep filters diagnostics inside
  heritage clauses and skips perturbing base/mixin/interface names.
- **`@ts-expect-error` coupling (TS2578).** When coverage differs, a directive that
  expected the missing error becomes "unused"; the sweep excludes TS2578.

### Recently resolved

- **Diagnostic line numbers differed between `tsc` emit and `tsc --noEmit` / IDE.**
  Mixin expansion adds/removes lines, and the emit path reprints the value-cast tree
  to text, so diagnostics landed on regenerated lines that did not exist on disk. The
  obvious fix (reuse the source-view tree for emit) is impossible — that tree is
  types-only and emits incorrect runtime JS, and a non-reparsed value-cast tree makes
  the checker invent diagnostics (TS2391 etc.). Resolved instead by keeping the
  reprinted tree for emit but capturing the printer's source map and remapping every
  emit-path diagnostic back to the real source position (`printSourceFileWithMappings`
  + `wrapProgramDiagnostics` in `src/index.ts`). Covered by
  `tests/emit-source-view-diagnostic-parity.t.ts`.
