// Appends the release date to the changeset-generated version heading.
//
// `changeset version` writes the version heading itself (`## 1.2.3`) and the
// changelog generator cannot influence it (see changesets#245, #480, #995), so
// we post-process: the topmost dateless `## x.y.z` heading — the entry that was
// just generated — becomes `## x.y.z - YYYY-MM-DD`. Only the first match is
// touched; older (already dated) entries are left alone.
//
// Run on Node >= 23 (native TypeScript type stripping): `node scripts/changelog-date.ts`.

import { readFileSync, writeFileSync } from "node:fs"

const date: string           = new Date().toISOString().slice(0, 10)
const versionHeading: RegExp = /^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/m

const file: string    = "CHANGELOG.md"
const text: string    = readFileSync(file, "utf8")
const updated: string = text.replace(versionHeading, `## $1 - ${date}`)

if (updated !== text) {
    writeFileSync(file, updated)
    console.log(`dated ${file}`)
}
