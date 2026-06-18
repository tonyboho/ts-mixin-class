# TODO

Open transformer bugs found against real consumers (notably the `ts-serializable`
package). Not published — `package.json` `files` whitelists only `dist/src` + `README.md`.

Each item has a `t.todo` marker test so it runs and stays visible (reported as
`[todo]` with failing assertions) without failing the suite.

---

## 1. IDE shows zero errors under `declaration: true` — tsserver semantic diagnostics crash

**Severity: high.** Opening a file with a valid `@mixin` class in a project whose
tsconfig has `"declaration": true` makes the editor show **no error squiggles at all**,
even though `tsc` reports real type errors. It is not "no errors" — the language
server's `semanticDiagnosticsSync` request **throws**, so the editor receives an error
response and renders nothing. Quickinfo/completions keep working (different code path),
which makes it look merely error-free.

**Root cause.** When `declaration` is enabled, semantic diagnostics also compute
declaration diagnostics, which run TypeScript's declaration-emit transform over the
**source-view** tree. It crashes on a generated declaration node whose parse-tree mapping
does not resolve:

```
Cannot read properties of undefined (reading 'kind')
  at isDeclarationAndNotVisible            // getParseTreeNode(node).kind on undefined
  at visitDeclarationSubtree
  at transformTopLevelDeclaration
  ... getDeclarationDiagnosticsForFile
  at getSemanticDiagnostics
```

Same family as AGENTS.md invariant #9, but reached through the **declaration-emit** path
rather than navigation.

**Why it was not caught.** The crash needs all three at once:
1. a *valid* mixin (generates the navigable `$base` interface/class helpers),
2. `declaration: true` (semantic diagnostics include declaration diagnostics), and
3. the tsserver/source-view path (generated nodes with broken parse-tree links).

The `declaration-fixture-suite` covers (1)+(2) but builds via **batch `tsc`** (the emit
path, over reprinted+reparsed source) — never (3). The `tsserver-diagnostics.t.ts` tests
cover (2)+(3) but on **invalid** mixins, which the transform rejects before generating any
`$base` helpers — never (1). `ts-serializable` is the first real code to hit all three.

- **Workaround:** `declaration: false` (but the package needs `.d.ts` to publish).
- **Marker test:** `tests/tsserver-declaration-emit-diagnostics.t.ts` (`t.todo`).
- **Fix direction:** make the declaration-emit path resolve `getParseTreeNode` for every
  generated declaration node in source view (extend the invariant-#9 alignment /
  `.original` handling to the declaration-emit transform, not only navigation).

---

## 2. Diagnostic line numbers differ between `tsc` emit and `tsc --noEmit` / IDE

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
