// Syncs the version pins in the README install snippet to the just-bumped package
// version, so the documented `package.json` example never drifts behind the
// published package.
//
// The README is a `ts-patch` ProgramTransformer install guide, so the example pins
// both `ts-mixin-class` and `ts-patch`. `changeset version` bumps `package.json`
// but leaves the README example untouched. Run right after it (in the `bump`
// script): set `"ts-mixin-class": "x.y.z"` to the current version and refresh
// `"ts-patch": "x.y.z"` to the catalog version pinned in `pnpm-workspace.yaml`.
//
// Run on Node >= 23 (native TypeScript type stripping): `node scripts/sync-readme-versions.ts`.

import { readFileSync, writeFileSync } from "node:fs"

const readme: string              = "README.md"
const pkg: { version: string }    = JSON.parse(readFileSync("package.json", "utf8"))
const tsPatch: string | undefined = readFileSync("pnpm-workspace.yaml", "utf8").match(/"ts-patch":\s*"([^"]+)"/)?.[1]

function pin(text: string, dependency: string, version: string | undefined): string {
    return version === undefined
        ? text
        : text.replace(new RegExp(`("${dependency}":\\s*")[^"]*(")`, "g"), `$1${version}$2`)
}

const original: string = readFileSync(readme, "utf8")
const updated: string  = pin(pin(original, "ts-mixin-class", pkg.version), "ts-patch", tsPatch)

if (updated !== original) {
    writeFileSync(readme, updated)
    console.log(`synced versions in ${readme}`)
} else {
    console.log(`README versions already in sync (${readme})`)
}
