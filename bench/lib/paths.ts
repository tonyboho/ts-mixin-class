import path from "node:path"
import { fileURLToPath } from "node:url"

// Resolved filesystem paths shared across scenarios. This module lives at
// dist/bench/lib/paths.js at runtime, so the package root is three levels up.

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
export const generatedRoot = path.join(packageRoot, "bench", "fixtures", "generated")
export const resultsRoot = path.join(packageRoot, "bench", "results")
export const tscFile = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")
export const tsserverFile = path.join(packageRoot, "node_modules", "typescript", "lib", "tsserver.js")
