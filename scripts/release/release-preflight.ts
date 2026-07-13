// Preflight safety checks for `pnpm release`.
//
// Releases run locally from `main` (see RELEASING.md). This guards the footguns
// of a local publish: it must run from a clean `main` that is not behind origin,
// with every changeset already applied via `pnpm bump` so the versions about to
// be published carry their changelog entries.
//
// Run on Node >= 23 (native TypeScript type stripping): `node scripts/release-preflight.ts`.

import { execFileSync } from "node:child_process"
import { globSync } from "node:fs"

function git(...args: string[]): string {
    return execFileSync("git", args, { encoding: "utf8" }).trim()
}

function fail(message: string): never {
    console.error(`✗ release preflight: ${message}`)
    process.exit(1)
}

const branch: string = git("rev-parse", "--abbrev-ref", "HEAD")
if (branch !== "main") {
    fail(`must run on 'main', currently on '${branch}'.`)
}

if (git("status", "--porcelain") !== "") {
    fail("working tree is not clean — commit or stash before releasing.")
}

git("fetch", "origin", "main", "--quiet")
const behind: string = git("rev-list", "--count", "HEAD..origin/main")
if (behind !== "0") {
    fail(`local 'main' is ${behind} commit(s) behind origin/main — pull first.`)
}

const pendingChangesets: string[] = globSync(".changeset/*.md").filter((file) => !file.endsWith("README.md"))
if (pendingChangesets.length > 0) {
    fail(`pending changesets found (${pendingChangesets.join(", ")}) — run \`pnpm bump\` and commit the version bump first.`)
}

console.log("✓ release preflight passed: clean 'main', in sync with origin, no pending changesets.")
