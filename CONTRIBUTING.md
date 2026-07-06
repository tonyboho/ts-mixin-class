# Contributing to ts-mixin-class

Thanks for your interest in improving `ts-mixin-class`! This document explains how to
set up the project, run the checks, and what a pull request needs to satisfy before it
can be merged.

## Prerequisites

- **Node.js** 24 or newer
- **pnpm** (the repository pins the version via the `packageManager` field — enable it
  with [Corepack](https://nodejs.org/api/corepack.html): `corepack enable`)

## Getting started

```shell
git clone https://github.com/tonyboho/ts-mixin-class.git
cd ts-mixin-class
pnpm install
```

`pnpm install` runs the `prepare` script, which invokes `ts-patch install` to patch the
local TypeScript. This is required — the transformer runs as a `ts-patch`
ProgramTransformer.

## Building

```shell
pnpm run build      # compile the transformer and the language-service plugin
pnpm run clean      # remove the dist output
```

## Running the checks

The same checks run in CI. Run them locally before opening a pull request:

```shell
pnpm run typecheck          # type-check the library
pnpm run typecheck:scripts  # type-check the scripts
pnpm run lint:check         # ESLint, zero warnings allowed
pnpm run test               # build, then run the Siesta test suite
```

`pnpm run release:check` runs the full gate (typecheck, build, lint, test, `publint`,
`attw`) exactly as it runs before a release.

## Benchmarks

The project ships a benchmark suite under `bench/`:

```shell
pnpm run bench             # full suite
pnpm run bench:transform   # transform throughput
pnpm run bench:compile     # end-to-end compile
pnpm run bench:tsserver    # editor/tsserver latency
pnpm run bench:edit        # incremental edit latency
```

Run the relevant benchmark before and after your change so you can show it does not
regress (see the pull request rules below).

## Testing philosophy

Tests are treated as the executable specification of the transformer's behavior — see
[docs/tests-as-specification.md](docs/tests-as-specification.md). New behavior is
described by tests first, and edge cases are pinned so they cannot silently regress.

## Pull request rules

A pull request must satisfy **all** of the following before it can be merged:

1. **All tests pass.** `pnpm run test` must be green (CI enforces this).
2. **New features are covered by tests.** Any new feature or behavior change must come
   with tests that exercise it. A behavioral PR without tests will not be merged.
3. **Test coverage must not decrease.** Do not remove or weaken existing tests to make a
   change pass. If a change makes a test obsolete, explain why in the PR description.
4. **Benchmarks must not regress.** If your change touches a hot path (the transform,
   linearization, or editor/tsserver code), include before/after benchmark numbers in
   the PR description and show there is no meaningful slowdown.

Beyond those hard rules:

- Keep the diff focused — one logical change per pull request.
- `pnpm run typecheck` and `pnpm run lint:check` must be clean.
- Match the style of the surrounding code (the ESLint config is the source of truth).

## Commit messages

The project follows [Conventional Commits](https://www.conventionalcommits.org/). Use a
type prefix and, where useful, the package scope:

```
feat(ts-mixin-class): qualified mixin references
fix(ts-mixin-class): guard use-before-declaration
docs(ts-mixin-class): clarify cooperative initialization
test(ts-mixin-class): pin parameter-property config behavior
```

User-facing changes should include a changeset:

```shell
pnpm run changeset
```

## Reporting bugs

Open an issue with a minimal reproduction — ideally a small snippet of the source that
triggers the wrong transform, diagnostic, or runtime behavior, plus what you expected.
A [StackBlitz](https://stackblitz.com) reproduction is the most useful, since it runs
the `ts-patch` build step.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
