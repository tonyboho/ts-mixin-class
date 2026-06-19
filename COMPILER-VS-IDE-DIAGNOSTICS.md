# Compiler (`tsc`) vs IDE diagnostics — parity report

How the **emit path** (`tsc` / `mode "emit"`, value-cast reprinted tree) and the **IDE
path** (`--noEmit` / tsserver / `mode "ide"`, position-preserving source-view tree)
differ in the diagnostics they report. Not published (dev doc).

## Method

Sweep the whole fixture corpus: for **every** identifier, append a suffix to one
occurrence — a syntactically valid edit that injects a real semantic error — then compile
the corpus twice (emit vs source-view) through the actual transformer and diff the
diagnostics. Reproduce with the categorising probe pattern in
`tests/stress-diagnostic-parity.t.ts`.

## Position parity holds — no line or column difference

For a diagnostic **both** paths report (matched on `file:line:code:message`, so two
different errors sharing a line + code are not conflated), they agree on **line and
column**. A filtered audit over 1273 single-identifier renames recorded **0 line drifts
and 0 column mismatches**. The emit path reprints the value-cast tree to text, so its raw
diagnostics land on regenerated lines; every emit diagnostic is remapped back through the
printer's source map to the real source position (`printSourceFileWithMappings` +
`wrapProgramDiagnostics` in `src/index.ts`, see `AGENTS.md` "Emit-path diagnostic
remapping"). So there is **no** position difference between the two paths — only a
difference in *which* diagnostics each reports, below.

## Real difference 1 — downstream-consumer contract coverage (compiler under-reports)

The value-cast emit tree types a consumer's view of a mixin more loosely than the
real-class source-view tree. A `@mixin` class that does not satisfy the contract it
`implements` is now flagged by **both** paths on the mixin *declaration* (the same TS2420,
same line and column — the `implements` clause is carried on the factory's inner runtime
class; see `AGENTS.md` "Emit-path implements conformance"). What still differs is the
*consumer* use-site:

| Code | Meaning | Where |
| --- | --- | --- |
| TS2741 | Property missing in type | a consumer used where the mixin's contract is expected |
| TS2551 | Property does not exist (did you mean) | consumer relying on a contract member |
| TS2339 | Property does not exist | consumer relying on a contract member |

The consumer sees the generated `interface X` that *inherited* the contract members, so it
has a type that structurally "has" them, and emit reports no consumer-side error. This is
**not** a `tsc`-green hole: the body is checked at the declaration (`class extends base
implements Contract`), so a contract violation never compiles either way — the editor
merely flags the use sites in addition. The sweep tolerates these source-view-only lines
and counts them as `ideOnlyCoverageGaps`; it only fails on emit-only lines.

## Real difference 2 — heritage-clause navigation (IDE mis-positions; residual)

For a base name inside `extends` / `implements`, source view rewrites the clause to a
generated `$base`, so it reports the error at a **synthetic position** with a garbled
message, while the compiler reports it at the **real** base name. Here the **compiler is
the correct one.** This now only applies to **generic** consumers, **construction-base**
consumers, and consumers emitting diagnostic validations — those keep the `$base` rewrite.
A well-typed **non-generic, non-construction** consumer takes the navigable-base fast path
(`extends (Base as unknown as <cast>)`, real base on its source position), so there the IDE
agrees with the compiler.

| Code | Compiler (correct) | IDE (synthetic) |
| --- | --- | --- |
| TS2304 | `Cannot find name 'Base'` at the `extends Base` site | `Cannot find name '}'` at a `$base` position |
| TS2552 | `Cannot find name 'UndefinedShapeBase'` at the real name | `Cannot find name '}'. Did you mean…` |
| TS2724 | `'"./mixins.js"' has no exported member named 'RequiredBase'` | `… named '"'` |

This is the heritage-navigation gap (`AGENTS.md` invariant #9). The parity test
ignores diagnostics inside heritage clauses and does not perturb base/mixin/interface
names. Every same-line+code column difference the raw sweep finds traces to this category
(a synthetic `$base` position) or to conflation of two *different* errors sharing a line +
code — never to a genuine column shift of the same diagnostic.

## What the parity test deliberately ignores

To assert position parity without tripping over the two differences above, the sweep
excludes: diagnostics inside a heritage clause (difference 2); perturbing
base / mixin / interface names (cascades into heritage); `TS2578 Unused '@ts-expect-error'`
(flips whenever coverage differs); and source-view-only diagnostics (difference 1 —
tolerated and counted, not failed). The remaining assertion is strict: emit never reports
on a line the source has no error on, and matches the source-view column wherever both
report the same `file:line:code:message`.
