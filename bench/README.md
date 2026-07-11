# Benchmarks

One command, one fixed set of metrics:

```bash
pnpm --silent run bench
```

It builds the package, runs every scenario with the pinned default config, prints
a full statistics table per scenario, and writes the same output to
`bench/results/report.txt` (gitignored). A run takes ~20s. Use `--silent` to drop
pnpm's command echo.

This is the canonical run: the defaults are fixed (3 samples + 1 warmup; transform
sizes `25/80/80/160`; fixture sizes `10,30`; `implicit` properties; `plain`
construction; dependency window `8`, seed `19871`), so two runs are comparable
without passing any flags. The environment variables below only matter when you
deliberately want a different shape; the everyday loop needs none of them.

## Scenarios

Each scenario maps to one way the transformer is actually used:

| Scenario | Command | What it measures | Transformer path |
| --- | --- | --- | --- |
| `transform` | `pnpm run bench:transform` | the per-file transform pipeline, no compiler around it | source-view + emit |
| `compile` | `pnpm run bench:compile` | one clean `tsc -p` over a generated project | emit, cross-file |
| `tsserver` | `pnpm run bench:tsserver` | one `semanticDiagnosticsSync` request in a real tsserver | source-view |
| `edit` | `pnpm run bench:edit` | edit a mixin + re-request consumer diagnostics (hottest IDE path) | source-view, incremental |

`pnpm run bench` runs all four. `node dist/bench/index.js <scenario>` runs one.

`compile` also runs a `base-chain` variant of the corpus (every mixin extends a class
from one deep `extends` chain) — the only rows that exercise the required-base
resolver; the plain corpus has no `extends` at all. Default: one row at size 30.

The `transform` scenario is in-process and fast (no `tsc`/`tsserver` fork), so it
is the right place to judge a transformer change before writing it. The other
three are end-to-end regression guards where the transformer's own cost is
diluted by TypeScript's bind + check.

There is also an **investigative** scenario, run only when named explicitly (never
by `pnpm run bench`):

| Scenario | Command | What it measures |
| --- | --- | --- |
| `config-shape` | `pnpm run bench:config-shape` | the checker cost of how the `<Class>Config` type could be SHAPED, over a deep `extends` hierarchy |

It does **not** exercise the transform — it hand-models the type surface each
candidate strategy would emit (`baseline` / `flat` = current / `tree-import` /
`tree-symbol` / `tree-static-symbol`) and compiles each with plain `tsc`, so the
numbers isolate the representation's own cost (see TODO.md → "Tree (incremental)
config"). It runs a **depth sweep** so the scaling curve is visible (`flat` ~O(D²),
`tree-import` ~O(D)). Knobs: `TS_MIXIN_BENCH_CONFIG_DEPTHS` (comma list, default
`4,8,16,32`), `TS_MIXIN_BENCH_CONFIG_CHAINS` (15), `TS_MIXIN_BENCH_CONFIG_PROPS` (6).

## Compare a change (measure, change, measure, compare)

Save a baseline, make the source change, re-run against the baseline:

```bash
# before the change
pnpm --silent run bench -- --save base

# ... edit src/ ...

# after the change: same metrics plus a Δ column vs the saved baseline
pnpm --silent run bench -- --baseline base
```

Baselines are JSON snapshots in `bench/results/` (gitignored). `--save`/
`--baseline` take a name with or without the `.json` suffix. The Δ column
compares each row's median against the baseline's.

## Output detail

`pnpm run bench` uses the full table (min / median / mean / max, sample count,
and the transform-pass step breakdown). The single-scenario scripts and a bare
`node dist/bench/index.js` default to a compact median-only table; pass `--full`
to expand them, or `--full` is implied for the top-level `bench` script.

## Common settings (environment)

```bash
TS_MIXIN_BENCH_ITERATIONS=3        # samples per row
TS_MIXIN_BENCH_WARMUPS=1           # warmup samples (not recorded)
TS_MIXIN_BENCH_TABLE=compact|full  # same as --full
```

### `transform` scenario

```bash
TS_MIXIN_BENCH_PASS_MODE=both|source-view|emit   # which pipelines to time
TS_MIXIN_BENCH_TRANSFORM_ITERATIONS=80           # inner passes per sample
TS_MIXIN_BENCH_TRANSFORM_SCENARIOS=80:3:4:8,...  # mixins:props:window:consumers
```

`TS_MIXIN_BENCH_TRANSFORM_ITERATIONS` is the number of transform passes inside
each measured sample; raising it steadies the per-pass timing.

### `compile`, `tsserver`, `edit` scenarios (generated fixtures)

```bash
TS_MIXIN_BENCH_SIZES=10,30              # default size list for all three groups
TS_MIXIN_BENCH_TSSERVER_SIZES=10,30     # override for tsserver
TS_MIXIN_BENCH_EDIT_SIZES=10,30         # override for edit
TS_MIXIN_BENCH_REQUIRED_BASE_SIZES=30   # override for the compile base-chain rows
TS_MIXIN_BENCH_PROPERTY_COUNT=1
TS_MIXIN_BENCH_PROPERTY_VISIBILITY=implicit|public
TS_MIXIN_BENCH_CONSTRUCTION=plain|base  # base: consumers extend Base and call .new(...)
TS_MIXIN_BENCH_DEP_MIN=1
TS_MIXIN_BENCH_DEP_MAX=3
TS_MIXIN_BENCH_DEP_WINDOW=8
TS_MIXIN_BENCH_EDIT_COUNT=8             # edits per edit-scenario sample
```

`public` generates explicit `public` fields; `implicit` (default) generates the
same fields without an accessibility modifier. `base` construction makes
consumers extend `ts-mixin-class/base` and call `Consumer.new(...)`, exercising
the public-only construction config path.

Larger release-style run:

```bash
env TS_MIXIN_BENCH_SIZES=25,100,250 \
    TS_MIXIN_BENCH_TSSERVER_SIZES=25,100 \
    TS_MIXIN_BENCH_EDIT_SIZES=25,100 \
    TS_MIXIN_BENCH_DEP_WINDOW=24 \
    pnpm --silent run bench -- --full
```

## Layout

```
bench/
  index.ts                 # orchestrator: CLI flags, runs scenarios, renders report + Δ
  lib/                     # env config, paths, table rendering + baseline, tsserver session
  scenarios/               # one file per scenario
  fixtures/generator.ts    # generated multi-file projects for the end-to-end scenarios
  fixtures/generated/      # generated output (gitignored)
  results/                 # saved baselines (gitignored)
  diagnostics/             # upstream-bug repros, not perf scenarios (see bench:ts-repro)
```

`bench:ts-repro` runs `diagnostics/typescript-interface-repro.ts`, a standalone
reproduction of the upstream TypeScript issue worked around in
`src/transitive-heritage-workaround.ts`. It is not part of `pnpm run bench`.
