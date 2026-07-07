import type * as ts from "typescript"

import {
    defaultTransformOptions,
    type FillMissedInitializersWith,
    type MixinClassTransformerConfig,
    type StaticCollisionCheckMode,
    type TransformOptions
} from "./model.js"
import type { TypeScript } from "./util.js"

// Plugin-config normalization and plane selection: resolves the ts-patch plugin config +
// compilation options into the effective TransformOptions, and decides which tree the
// host serves (printed for emit, position-preserving clone for the IDE/source view).

// The compilation's EFFECTIVE `useDefineForClassFields`: the explicit option, or TypeScript's
// own default of `target >= ES2022`.
export function effectiveUseDefineForClassFields(tsInstance: TypeScript, compilerOptions: ts.CompilerOptions): boolean {
    return compilerOptions.useDefineForClassFields ??
        (compilerOptions.target ?? tsInstance.ScriptTarget.ES3) >= tsInstance.ScriptTarget.ES2022
}

export function resolveTransformOptions(
    config: MixinClassTransformerConfig,
    useDefineForClassFields?: boolean,
    experimentalDecorators?: boolean,
    isolatedDeclarations?: boolean
): TransformOptions {
    return {
        packageName                : config.packageName ?? defaultTransformOptions.packageName,
        decoratorName              : config.decoratorName ?? defaultTransformOptions.decoratorName,
        sourceView                 : false,
        useDefineForClassFields    : useDefineForClassFields ?? defaultTransformOptions.useDefineForClassFields,
        experimentalDecorators     : experimentalDecorators ?? defaultTransformOptions.experimentalDecorators,
        isolatedDeclarations       : isolatedDeclarations ?? defaultTransformOptions.isolatedDeclarations,
        staticCollisionCheck       : normalizeStaticCollisionCheck(config.staticCollisionCheck),
        fillMissedInitializersWith : normalizeFillMissedInitializers(config.fillMissedInitializersWith),
        // Read at build time (the transformer runs under tsc in Node) and baked into the emit
        // as a trailing mode argument, so the shipped runtime never reads the environment.
        // Verification is on by default (set TS_MIXIN_VERIFY_LINEARIZATION=0 to drop it in
        // production); the precompute is on unless TS_MIXIN_DISABLE_LINEARIZATION_PLAN=1.
        verifyLinearization        : envFlag("TS_MIXIN_VERIFY_LINEARIZATION") !== "0" &&
            envFlag("TS_MIXIN_VERIFY_LINEARIZATION") !== "false",
        disableLinearizationPlan : envFlag("TS_MIXIN_DISABLE_LINEARIZATION_PLAN") === "1" ||
            envFlag("TS_MIXIN_DISABLE_LINEARIZATION_PLAN") === "true"
    }
}

function envFlag(name: string): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
}

function normalizeStaticCollisionCheck(
    value: MixinClassTransformerConfig["staticCollisionCheck"]
): StaticCollisionCheckMode {
    if (value === undefined) {
        return defaultTransformOptions.staticCollisionCheck
    }

    if (value === true) {
        return "strict"
    }

    return value
}

function normalizeFillMissedInitializers(
    value: MixinClassTransformerConfig["fillMissedInitializersWith"]
): FillMissedInitializersWith {
    if (value === undefined) {
        return defaultTransformOptions.fillMissedInitializersWith
    }

    if (value !== "undefined" && value !== "null" && value !== "nothing") {
        throw new Error(
            `ts-mixin-class: unknown "fillMissedInitializersWith" option ${JSON.stringify(value)}, ` +
            `expected "undefined", "null", or "nothing".`
        )
    }

    return value
}

export function resolveUsePrintedSourceFile(
    config: MixinClassTransformerConfig,
    compilerOptions: ts.CompilerOptions
): boolean {
    const mode = config.mode

    if (mode === undefined) {
        if (isTypeScriptServerProcess()) {
            return false
        }

        return shouldCreatePrintedSourceFileForEmit(compilerOptions)
    }

    if (mode !== "emit" && mode !== "ide") {
        throw new Error(`ts-mixin-class: unknown "mode" option ${JSON.stringify(mode)}, expected "emit" or "ide".`)
    }

    return mode === "emit"
}

function shouldCreatePrintedSourceFileForEmit(compilerOptions: ts.CompilerOptions): boolean {
    return !compilerOptions.noEmit && !isTypeScriptServerProcess()
}

function isTypeScriptServerProcess(): boolean {
    const argv = (globalThis as { process?: { argv?: string[] } }).process?.argv ?? []

    return argv.some((argument) => {
        const fileName = argument.replaceAll("\\", "/").split("/").at(-1)

        return fileName === "tsserver.js" || fileName === "_tsserver.js"
    })
}
