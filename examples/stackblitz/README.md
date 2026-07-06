# ts-mixin-class — runnable example

A minimal, self-contained project that runs the `ts-mixin-class` transformer and
prints the result. Open it in StackBlitz:

**https://stackblitz.com/github/tonyboho/ts-mixin-class/tree/main/examples/stackblitz**

Or run it locally:

```shell
npm install
npm start
```

`npm start` compiles [src/main.ts](src/main.ts) with `tspc` (the `ts-patch` compiler
that applies the transform) and runs the output with Node.

The example shows:

- two mixins composed into a class with native `implements`,
- `super` calls reaching into the mixin chain,
- C3 linearization on a diamond,
- `instanceof` on mixins,
- generics.

This folder is deliberately standalone (plain `package.json`, no pnpm workspace) so it
installs cleanly in any environment, including StackBlitz WebContainers.
