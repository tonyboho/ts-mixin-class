# TODO

Open transformer bugs found against real consumers (notably the `ts-serializable`
package). Not published — `package.json` `files` whitelists only `dist/src` + `README.md`.

---

_No currently-open bugs._

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
