import type * as ts from "typescript"
import type { ProgramTransformerExtras } from "ts-patch"
import { createMixinClassCompilerHost, registryCacheKey } from "./compiler-host.js"
import { wrapProgramDiagnostics } from "./emit-diagnostic-remap.js"
import type { MixinClassTransformerConfig, NativeMixinDiagnostic } from "./model.js"
import { buildConstructionBaseRegistry, buildMixinRegistry } from "./registry.js"
import { hasRuntimeModuleForDeclaration } from "./registry-declaration-file.js"
import { effectiveUseDefineForClassFields, resolveTransformOptions } from "./transform-options.js"

export * from "./base.js"
export * from "./runtime.js"
export type {
    CrossFileContext,
    MixinClassTransformerConfig,
    MixinClassTransformerMode,
    MixinRegistry,
    RegisteredMixin,
    StaticCollisionCheckMode
} from "./model.js"
export { createMixinClassCompilerHost } from "./compiler-host.js"
export { hasMixinDecorator } from "./decorators.js"
export { buildMixinRegistry } from "./registry.js"
export { transformSourceFile } from "./transform-source-file.js"
export { printSourceFile } from "./util.js"

// ---------------------------------------------------------------------------
// ts-patch ProgramTransformer

export default function transformProgram(
    program: ts.Program,
    host: ts.CompilerHost | undefined,
    config: MixinClassTransformerConfig,
    { ts: tsInstance }: ProgramTransformerExtras
): ts.Program {
    const compilerOptions           = program.getCompilerOptions()
    const compilerHost              = host ?? tsInstance.createCompilerHost(compilerOptions)
    const options                   = resolveTransformOptions(
        config,
        effectiveUseDefineForClassFields(tsInstance, compilerOptions),
        compilerOptions.experimentalDecorators === true,
        compilerOptions.isolatedDeclarations === true
    )
    const resolvedModuleFileNames   = new Map<string, string | undefined>()
    const runtimeModuleAvailability = new Map<string, boolean>()

    const resolveModuleFileName = (specifier: string, containingFile: string): string | undefined => {
        const cacheKey = `${containingFile}\0${specifier}`

        if (resolvedModuleFileNames.has(cacheKey)) {
            return resolvedModuleFileNames.get(cacheKey)
        }

        const resolvedFileName = tsInstance.resolveModuleName(specifier, containingFile, compilerOptions, compilerHost)
            .resolvedModule?.resolvedFileName

        resolvedModuleFileNames.set(cacheKey, resolvedFileName)

        return resolvedFileName
    }
    const canImportRuntimeValue = (resolvedFileName: string): boolean => {
        const cached = runtimeModuleAvailability.get(resolvedFileName)

        if (cached !== undefined) {
            return cached
        }

        const available = hasRuntimeModuleForDeclaration(tsInstance, compilerHost, resolvedFileName)

        runtimeModuleAvailability.set(resolvedFileName, available)

        return available
    }

    const registry          = buildMixinRegistry(tsInstance, program, options, resolveModuleFileName)
    const constructionBases = buildConstructionBaseRegistry(tsInstance, program, options, resolveModuleFileName, registry)
    // Per-program sink the transform pushes native diagnostics into and the diagnostic wrap
    // drains. Shared by reference with `crossFile` (where the transform reaches it) below.
    const nativeDiagnostics: NativeMixinDiagnostic[] = []
    const crossFile                                  = registry.size === 0 && constructionBases.size === 0
        ? undefined
        : {
            registry,
            constructionBases,
            cacheKey           : registryCacheKey(registry, constructionBases),
            resolveModuleFileName,
            canImportRuntimeValue,
            linearizationCache : new Map<string, string[]>()
        }
    const nextHost                                   = createMixinClassCompilerHost(tsInstance, compilerHost, compilerOptions, config, crossFile, program, nativeDiagnostics)

    return wrapProgramDiagnostics(
        tsInstance,
        tsInstance.createProgram(
            program.getRootFileNames(),
            compilerOptions,
            nextHost,
            undefined
        ),
        program,
        nativeDiagnostics,
        crossFile,
        options,
        nextHost
    )
}
