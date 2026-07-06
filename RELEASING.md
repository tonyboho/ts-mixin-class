# Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets) and run
**locally from `main`**. `changeset publish` only pushes the package when its local version
is **ahead of the npm registry**, so a release with no version bump is a no-op.

## 1. Describe each change with a changeset

On a feature branch, for every user-facing change:

```sh
pnpm changeset
```

This interactive prompt asks the bump type (`patch` / `minor` / `major`) and writes a markdown
file under `.changeset/`. Commit it with the change. Test-only or internal changes do not need a
changeset — see the changeset-writing policy in `AGENTS.md`.

## 2. Version the package

On an up-to-date `main`:

```sh
pnpm bump
```

This runs `changeset version` (consumes the pending changesets, bumps the version, writes
`CHANGELOG.md`), then dates the new changelog heading and syncs the README install-snippet
versions. Review the version bump and changelog, trim the entries if needed, and commit:

```sh
git commit -am "chore: release <version>"
```

## 3. Publish

```sh
pnpm release
```

This runs, in order:

1. `release:preflight` — asserts a clean `main`, not behind `origin/main`, with no leftover
   changesets (i.e. step 2 was done and committed).
2. `release:check` — `clean → typecheck → build → lint:check → test → publint → attw`. The full
   gate must pass before anything is published.
3. `changeset publish` — publishes to npm and creates the matching git tag.
   `npm` may prompt for an OTP if 2FA is enabled.
4. `git push --follow-tags` — pushes the release commit and tag.

Requires an `npm login` with publish rights to the package.
