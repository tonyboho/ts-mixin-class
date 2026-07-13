import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import tsModule from "typescript"
import { buildMixinRegistry, printSourceFile, transformSourceFile } from "../../src/index.js"
import { buildConstructionBaseRegistry } from "../../src/registry.js"
import { buildRequiredBaseContext } from "../../src/required-base-plan.js"
import { defaultTransformOptions, type CrossFileContext } from "../../src/model.js"
import type { TypeScript } from "../../src/util.js"
import type { BenchmarkFixture } from "./generator.js"

// Rewrites a generated fixture IN PLACE into its TRANSFORMED (emit-plane) form — the
// exact trees the compiler host would hand tsc — and strips the transformer plugin from
// the tsconfig, so a bench run then measures the CHECKER cost of the generated shapes
// alone, with the transformer's own cost out of the picture.
//
// The PHANTOM form is the TODO idea's cheap falsification (no src changes): the factory
// `base` parameter's anonymous instance intersection
//
//     base: __AnyConstructor__<Base3 & Mixin6> & <statics tail>
//
// becomes a declared "ancestors-only" interface —
//
//     export interface __Mixin7$ancestors extends Base3, Mixin6 {}
//     base: __AnyConstructor__<__Mixin7$ancestors> & <statics tail>
//
// — a stable declared type the checker resolves once and relation-caches, instead of a
// fresh anonymous instance surface per mixin. Instance side only (an interface cannot
// extend the mapped/`typeof` statics bags); this is the one site that scales with the
// corpus (per mixin), the consumer's cast being O(1) per project.

export type PretransformForm = "flat" | "phantom"

const tsInstance = tsModule as unknown as TypeScript

export async function pretransformFixture(fixture: BenchmarkFixture, form: PretransformForm): Promise<void> {
    const configFile = tsModule.readConfigFile(fixture.tsconfigFile, tsModule.sys.readFile)

    if (configFile.error !== undefined) {
        throw new Error(`Cannot read ${fixture.tsconfigFile}: ${JSON.stringify(configFile.error.messageText)}`)
    }

    const config = configFile.config as { compilerOptions?: { plugins?: unknown } }

    delete config.compilerOptions?.plugins

    const parsed = tsModule.parseJsonConfigFileContent(config, tsModule.sys, fixture.directory)

    const program = tsModule.createProgram(parsed.fileNames, parsed.options)

    const resolveModuleFileName = (specifier: string, containingFile: string): string | undefined =>
        tsModule.resolveModuleName(specifier, containingFile, parsed.options, tsModule.sys).resolvedModule?.resolvedFileName

    const registry          = buildMixinRegistry(tsInstance, program, {}, resolveModuleFileName)
    const constructionBases = buildConstructionBaseRegistry(tsInstance, program, {}, resolveModuleFileName, registry)
    const requiredBases     = buildRequiredBaseContext(tsInstance, program, registry, { ...defaultTransformOptions })

    const crossFile: CrossFileContext = {
        registry,
        constructionBases,
        requiredBases,
        cacheKey              : "bench-pretransform",
        resolveModuleFileName,
        canImportRuntimeValue : () => true,
        linearizationCache    : new Map()
    }

    const sourceRoot = path.join(fixture.directory, "src")

    for (const sourceFile of program.getSourceFiles()) {
        if (!sourceFile.fileName.startsWith(sourceRoot.replaceAll("\\", "/")) && !sourceFile.fileName.startsWith(sourceRoot)) {
            continue
        }

        const transformed = transformSourceFile(tsInstance, sourceFile, {}, crossFile)

        if (transformed === sourceFile) {
            continue
        }

        const text = printSourceFile(tsInstance, transformed)

        await writeFile(sourceFile.fileName, form === "phantom" ? phantomRewrite(text) : text)
    }

    // The fixture now IS the transformed output — recompiling it through the plugin
    // would transform twice.
    const rawConfig = JSON.parse(await readFile(fixture.tsconfigFile, "utf8")) as {
        compilerOptions? : { plugins?: unknown }
    }

    delete rawConfig.compilerOptions?.plugins
    await writeFile(fixture.tsconfigFile, `${JSON.stringify(rawConfig, null, 4)}\n`)
}

// Replace each factory `base` parameter's anonymous instance intersection with a
// declared ancestors-only interface. Intentionally corpus-specific: the bench corpus's
// intersection terms are plain identifiers (`Base3 & Mixin6`), so a flat text rewrite is
// exact; a single-term surface (`AnyConstructor<Base0>`) is left alone — there is no
// intersection to flatten.
function phantomRewrite(text: string): string {
    return text.replace(
        /export const __(\w+)\$mixin = function \(base: __AnyConstructor__<([^<>]+)>/g,
        (match, name: string, instance: string) => {
            const terms = instance.split(" & ")

            if (terms.length < 2) {
                return match
            }

            return `export interface __${name}$ancestors extends ${terms.join(", ")} {\n}\n` +
                `export const __${name}$mixin = function (base: __AnyConstructor__<__${name}$ancestors>`
        }
    )
}
