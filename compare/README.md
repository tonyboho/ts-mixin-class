# Mixin library comparison (empirical)

A small, standalone harness that compares TypeScript mixin libraries by **actually
running** them, rather than trusting their docs. Not published (private package; the root
`package.json` `files` field does not include this folder).

## Results

| Library | Native syntax | Reaches all mixins | Dedup | C3 order | Rejects bad order | `instanceof` | Generics | Zero runtime |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **ts-mixin-class** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| @alizurchik/ts-mixin | ❌ | ❌ | n/a | ❌ | ❌ | ❌ | ⚠️ | ❌ |
| @open-wc/dedupe-mixin | ❌ | ✅ | ✅ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ |
| mixedin | ❌ | ❌ | n/a | ❌ | ❌ | ✅ | ✅ | ❌ |
| mixin-types | ❌ | ✅ | ❌ | ❌ | ❌ | ⚠️ | ✅ | ❌ |
| mixwith | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ |
| polytype | ❌ | ❌ | n/a | ❌ | ❌ | ✅ | ✅ | ❌ |
| ts-mixer | ❌ | ❌ | n/a | ❌ | ❌ | ⚠️ | ⚠️ | ❌ |
| typed-mixins | ❌ | ❌ | n/a | ❌ | ❌ | ⚠️ | ❌ | ❌ |
| typescript-mix | ❌ | ❌ | n/a | ❌ | ❌ | ❌ | ❌ | ❌ |
| typescript-mixin | ❌ | ❌ | n/a | ❌ | ❌ | ⚠️ | ✅ | ❌ |

`run.mjs` regenerates this table. The behavioural columns come from running the code; the
rest are structural — see below.

## Run it

```shell
npm install
npm run compare     # builds everything with the transformer, runs every probe, prints the table
npm run conflict    # shows ts-mixin-class rejecting an impossible order (TS990007)
```

## Layout

- `src/` — one **self-contained, idiomatic** file per library (including `ts-mixin-class`
  itself), written the way you would actually use that library. Everything is compiled by
  **`tspc`** (the `ts-patch` compiler that runs the `ts-mixin-class` transformer); the
  transformer only touches `@mixin`/`implements` classes and passes every other library's
  code through untouched. No esbuild/tsx.
- `conflict/` — a `ts-mixin-class` fixture with two mixins that demand incompatible orders;
  it is built (not run) to show the compile-time rejection.
- `run.mjs` — runs each compiled probe and prints the comparison table.

## The scenarios

Each file runs the same three scenarios and prints one line each:

- **basic** — `Root`, then `Left` and `Right` that build on it, then a `Combined` that
  uses both. `new Combined().chain()` walks the chain via `super`. Correct C3 order is
  `Combined > Left > Right > Root`.
- **deep** — a shared intermediate: `Base <- Shared <- Left, Right`. Correct C3 is
  `Combined > Left > Right > Shared > Base`, with `Shared` appearing **once**.
- **bad** — two mixins that demand incompatible orders (`A→B` and `B→A`). `ts-mixin-class`
  rejects it at compile time; the runtime libraries silently pick some order.

## Reading the results

- a mixin **missing** from the output (e.g. `Combined > Right > Root`) — the library
  dropped a mixin; there is no real linearization.
- **full but reversed** (`Combined > Right > Left > Root`) — `super` works, but the order
  is just argument order, not C3.
- `Shared` appearing **twice** in the deep output — no deduplication of the intermediate.
- `Combined > Left > Right > Shared > Base` — correct C3 (only `ts-mixin-class`).

In the printed table, the **behavioural** columns (reaches all mixins, dedup, C3 order,
rejects bad order, `instanceof`) are derived from what the library actually did. **Native
syntax / Zero runtime / Generics** are structural — set by hand in `run.mjs`, since they
describe how the code is written and what it costs, not something a run can observe.

## Caveats (kept honest)

- **mixedin** needs `Map.prototype.getOrInsertComputed`, absent on Node 24; `src/polyfill.ts`
  provides it so the library can run at all.
- **@alizurchik/ts-mixin** throws when composing classes that share a base.
- **typescript-mix** / **typescript-mixin** are decorator / prototype-copy libraries with
  no `super` chain — the mixed methods are copied, not linked.
