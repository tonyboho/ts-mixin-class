# TODO

Open transformer bugs found against real consumers (notably the `ts-serializable`
package). Not published — `package.json` `files` whitelists only `dist/src` + `README.md`.

---

## 1. Diagnostic line numbers differ between `tsc` emit and `tsc --noEmit` / IDE

**Severity: medium.** The same errors land on **different lines** depending on the build
mode, because `transformProgram` reprints regenerated text on the emit path and the
diagnostics map to that regenerated text, not the file on disk.

Evidence (`ts-serializable/src/Serializable.ts`, same 10 errors):

| construct            | `--noEmit` | `tsc` emit |
| -------------------- | ---------: | ---------: |
| first `entry as …`   |        223 |  238 (+15) |
| native `toJSON`      |        291 |  290 (−1)  |
| last `toJSON` (Error)|        354 |  346 (−8)  |

The shift is **non-uniform** (mixin classes above add lines; removed decorators / rewritten
`extends` below remove them) — it is genuinely different text, not an offset. The emit
coordinates point at regenerated source that does not exist in the editor. There is also a
**semantic** divergence: `tests/serializable.t.ts:63` is `TS2720` under `--noEmit` but
`TS2420` under emit (the transformed tree differs structurally there).

- **Fix direction (per design discussion):** the emit path should reuse the
  position-preserving (source-view) tree like the language server does, instead of the
  reprinted text, so diagnostic positions stay anchored to the real source.
- **Marker test:** _none yet_ — add one that asserts the two paths report a diagnostic at
  the same source position.
