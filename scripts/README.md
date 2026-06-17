# Debugging scripts

Reusable replacements for the throwaway scripts you'd otherwise write to inspect
the transformer. Build once (`pnpm build`), then run from the package root:

```bash
node dist/scripts/<script>.js [options]
```

Input for the single-file scripts comes from (in order): `--file <path>`, a bare
positional path, `--code "<snippet>"`, or piped stdin. A snippet is only
transformed if it imports `mixin` / `Base` from the package, e.g.
`import { Base, mixin } from "ts-mixin-class"`.

Common options: `--mode emit|ide|both`, `--package-name <name>`,
`--allow-undefined` (sets `allowUndefinedForRequiredProperties`).

`ide` = the position-preserving **source-view** pass (what tsserver / the IDE and
`tsc --noEmit` use). `emit` = the printed pass (what `tsc` emits). Bugs usually
differ between the two — see the construction-`new` invariants in `../AGENTS.md`.

## `print-transformed.js`

Print the transformed code for a snippet, in emit and/or source-view mode.

```bash
node dist/scripts/print-transformed.js --file tests/fixture-suite/src/foo.t.ts
echo 'import { Base, mixin } from "ts-mixin-class"
@mixin() class S extends Base { public x?: number = 1 }' | node dist/scripts/print-transformed.js --mode ide
```

## `print-ast.js`

Print the transformed AST as an indented tree with each node's `[pos, end]`,
flagging the range shapes that break tsserver: `⚠ NEGATIVE` (`-1`),
`⚠ ZERO-WIDTH`, and the `<members[]>` NodeArray range of each class/interface.
Defaults to `ide` mode (ranges only matter there).

```bash
node dist/scripts/print-ast.js --file tests/fixture-suite/src/foo.t.ts
```

## `program-diagnostics.js`

Run the real ProgramTransformer over a whole tsconfig (cross-file registry and
all) and read what the checker sees — the practical stand-in for "what does the
language server report" without a tsserver process. This is the script to reach
for cross-file behavior, which the single-file scripts cannot reproduce.

```bash
# fixture-suite, ide mode, all files
node dist/scripts/program-diagnostics.js

# one transformed file, printed, with its diagnostics
node dist/scripts/program-diagnostics.js --file repro --print

# resolved type of every `.new` access (emit vs ide can differ)
node dist/scripts/program-diagnostics.js --file repro --types new

# what `tsc` (emit) checks instead of the IDE
node dist/scripts/program-diagnostics.js --mode emit --file repro
```

Options: `--tsconfig <path>` (default `tests/fixture-suite/tsconfig.json`),
`--file <substring>`, `--mode emit|ide`, `--print`, `--types <propertyName>`.
`type-errors.ts` in the fixture suite is intentionally broken — pass `--file` to
avoid its noise.
