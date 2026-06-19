# Compiler (`tsc`) vs IDE diagnostics — parity report

How the **emit path** (`tsc` / `mode "emit"`, value-cast reprinted tree) and the **IDE
path** (`--noEmit` / tsserver / `mode "ide"`, position-preserving source-view tree)
differ in the diagnostics they report. Not published (dev doc).

## Method

Sweep the whole fixture corpus: for **every** identifier (1485 of them), append a
suffix to one occurrence — a syntactically valid edit that injects a real semantic error
— then compile the corpus twice (emit vs source-view) through the actual transformer and
diff the diagnostics. Reproduce with the categorising probe pattern in
`tests/stress-diagnostic-parity.t.ts` (which asserts the line/column guarantees) and the
ad-hoc audit used to build this report.

## Headline

For a diagnostic **both** paths report, they now agree on **line and column**. A filtered
audit (1273 single-identifier renames — excluding the documented divergences below)
recorded **0 line drifts and 0 column mismatches**. Every residual position difference in
the raw, unfiltered sweep traces to one of the documented dual-tree divergences below, not
to the reprint. What genuinely differs is *which* diagnostics each path reports (the two
trees are not type-equivalent), summarised next.

## 1. Compiler under-reports — IDE-only errors (the important one)

The value-cast emit tree types mixin members / contracts **more loosely** than the
real-class source-view tree, so the IDE flags errors `tsc` stays silent on. **`tsc` /
CI can pass while the editor shows red.** Triggered by renaming a mixin member or a
consumer that relies on one.

| Code | Meaning | Example |
| --- | --- | --- |
| TS2741 | Property missing in type | `Property 'contractMethod' is missing in type '}'` |
| TS2551 | Property does not exist (did you mean) | `Property 'contractMethod' does not exist on type 'Contract…'` |
| TS2420 | Class incorrectly implements interface | `Class 'ContractMixin' incorrectly implements interface…` |
| TS2720 | Class incorrectly implements class | `Class 'ValueLabel<T>' incorrectly implements class 'Stored…'` |
| TS2339 | Property does not exist | `Property 'value' does not exist on type 'Box<T>'` |

**Status:** pre-existing dual-tree gap, **not** a line/column remap issue. Closing it
means making the value-cast emit model type-check like source view — a large, separate
effort. Tracked in `TODO.md`.

## 2. IDE under-reports / mis-positions — compiler-only errors (heritage gap)

For a base name inside `extends` / `implements`, source view rewrites the clause to a
generated `$base`, so it reports the error at a **synthetic position** with a garbled
message (`Cannot find name '}'`, `… named '"'`), while the compiler reports it at the
**real** base name. Here the **compiler is the correct one.**

| Code | Compiler (correct) | IDE (synthetic) |
| --- | --- | --- |
| TS2304 | `Cannot find name 'Base'` at the `extends Base` site | `Cannot find name '}'` at a `$base` position |
| TS2552 | `Cannot find name 'UndefinedShapeBase'` at the real name | `Cannot find name '}'. Did you mean…` |
| TS2724 | `'"./mixins.js"' has no exported member named 'RequiredBase'` | `… named '"'` |

**Status:** the documented heritage-navigation gap (see `AGENTS.md` invariant #9 "Known
gap"). The parity test ignores diagnostics inside heritage clauses and does not perturb
base/mixin/interface names.

## 3. Same error, different column — none genuine

Every same-line+code column difference the sweep found is one of:

- a **heritage** artifact (category 2 — e.g. TS2552 emit col 2 vs IDE col 1 on the `}`),
- an **IDE synthetic-position** artifact (category 2 — e.g. TS2724 `'"'`),
- **conflation** of two *different* errors that share a line + code — e.g. on
  `return \`${this.prefix}/${this.label()}\``, the compiler flags `label` (one column)
  while the IDE flags `prefix` (another). Different errors, not a shifted column. The
  parity test matches on `file:line:code:message`, so these no longer count as a column
  mismatch.

There is **no** case where the same diagnostic (same message) lands on a different
column in the two paths.

## 4. What the parity test deliberately ignores

To assert the remap's guarantee (no line drift, matching columns for shared diagnostics)
without tripping over the dual-tree divergences above, the sweep excludes:

- **Diagnostics inside a heritage clause** — category 2 (compiler correct, IDE synthetic).
- **Perturbing base / mixin / interface names** — renaming a base cascades into the
  heritage and required-base generated-reference gaps.
- **TS2578 `Unused '@ts-expect-error'`** — a meta-diagnostic that flips whenever coverage
  differs (category 1 makes a directive look unused), not a position signal.
- **Source-view-only diagnostics** (category 1) — tolerated and counted, not failed.

The remaining assertion is strict: emit never reports on a line the source has no error
on, and matches the source-view column wherever both report the same `file:line:code:message`.
