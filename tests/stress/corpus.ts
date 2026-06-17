import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { packageRoot } from "../util.js"

// The stress corpus is the real mixin fixture suite: a spread of `@mixin`
// classes, `extends Base` construction bases, `implements` chains, generics and
// construction `new` usages. These files are excluded from the package tsconfig
// (they are a separately-compiled fixture), so here they are read purely as
// text and fed to the transform / language service.

export type CorpusFile = {
    fileName : string,
    text     : string
}

const corpusDirectory = path.join(packageRoot, "tests", "fixture-suite", "src")

export function loadCorpus(): CorpusFile[] {
    const files = readdirSync(corpusDirectory)
        .filter((name) => name.endsWith(".ts"))
        // Sorted so a given seed always maps to the same file index.
        .sort()
        .map((name): CorpusFile => ({
            fileName : name,
            text     : readFileSync(path.join(corpusDirectory, name), "utf8")
        }))

    if (files.length === 0) {
        throw new Error(`No corpus files found in ${corpusDirectory}`)
    }

    return files
}
