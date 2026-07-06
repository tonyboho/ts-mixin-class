# Mixin library comparison (empirical)

A small, standalone harness that compares TypeScript mixin libraries by **actually
running** them, rather than trusting their docs. Not published (private package; the root
`package.json` `files` field does not include this folder).

Every library is compiled with a **real compiler**, never esbuild/tsx:

- `ts-mixin-class` is built with **`tspc`** (the `ts-patch` compiler that runs its program
  transformer) — `tsconfig.tsmc.json`, sources in `tsmc/`.
- Every other library is built with **stock `tsc`** (legacy decorators enabled) —
  `tsconfig.json`, sources in `linearization/`.

## Run it

```shell
npm install
npm run compare     # builds everything, prints each library's linearization
npm run conflict    # shows ts-mixin-class rejecting an impossible order (TS990007)
```

## The probe

Each file in `linearization/` is a **self-contained, idiomatic** example written the way
you would actually use that library. The scenario is always the same four mixins:

```
Root                 chain() => "Root"
Left  (uses Root)    chain() => "Left > "  + super.chain()
Right (uses Root)    chain() => "Right > " + super.chain()
Combined (uses Left, Right)   chain() => "Combined > " + super.chain()
```

`new Combined().chain()` walks the chain via `super`. The returned string **is** the
linearization the library produces. Correct C3 is:

```
Combined > Left > Right > Root
```

Read the result like this:

- **a mixin missing** (e.g. `Combined > Right > Root`) — the library dropped a mixin from
  the chain; there is no real linearization.
- **full but reversed** (`Combined > Right > Left > Root`) — `super` works, but the order
  is just application order, not C3.
- **`Combined > Left > Right > Root`** — correct C3 (only `ts-mixin-class`).

`conflict-tsmc/` sets up two mixins that demand incompatible orders (`A→B` and `B→A`).
`ts-mixin-class` rejects it at **compile time** with `TS990007`; the runtime libraries
silently pick some order.

## Caveats (kept honest)

- **mixedin** needs `Map.prototype.getOrInsertComputed`, absent on Node 24; `linearization/polyfill.ts`
  provides it so the library can run at all.
- **@alizurchik/ts-mixin** throws when composing classes that share a base.
- **typescript-mix** / **typescript-mixin** are decorator / prototype-copy libraries with no
  `super` chain — the mixed methods are copied, not linked.
