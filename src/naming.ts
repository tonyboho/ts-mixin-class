import type * as ts from "typescript"
import type { StaticCollisionCheckMode } from "./model.js"

// Every identifier the transform can generate or inject, in one place: the package's
// public helper names, their reserved double-underscore LOCAL aliases (so an injected
// import can never collide with a user binding, TS2440), the suffixes of the generated
// sibling declarations (`__X$mixin`, `__X$base`, ...), and the name builders on top.

export const anyConstructorName = "AnyConstructor"
export const classStaticsName = "ClassStatics"
export const defineMixinClassName = "defineMixinClass"
export const mixinChainName = "mixinChain"
export const mixinChainLinearizedName = "mixinChainLinearized"
// The VALUE helpers are imported under reserved double-underscore LOCAL aliases so the injected
// import can never collide with a user binding of the package name (TS2440).
export const defineMixinClassLocalName = "__defineMixinClass__"
export const applyLegacyClassDecoratorsName = "applyLegacyClassDecorators"
export const applyLegacyClassDecoratorsLocalName = "__applyLegacyClassDecorators__"
export const mixinChainLocalName = "__mixinChain__"
export const mixinChainLinearizedLocalName = "__mixinChainLinearized__"
export const mixinApplicationName = "MixinApplication"
export const mixinFactoryName = "MixinFactory"
export const runtimeMixinClassName = "RuntimeMixinClass"
export const mixinClassValueName = "MixinClassValue"
export const constructionMixinClassValueName = "ConstructionMixinClassValue"
export const staticNeverConflictKeysName = "StaticNeverConflictKeys"
export const staticStrictConflictKeysName = "StaticStrictConflictKeys"
export const metadataBaseImportName = "base"
export const metadataBaseLocalName = "__mixinBase"
export const mixinFactorySuffix = "$mixin"
export const mixinRuntimeClassSuffix = "$class"
export const consumerBaseSuffix = "$base"
export const consumerEmptyBaseSuffix = "$empty"
export const mixinValueSuffix = "$mixinValue"

export function staticConflictKeysName(mode: Exclude<StaticCollisionCheckMode, false>): string {
    return mode === "strict" ? staticStrictConflictKeysName : staticNeverConflictKeysName
}

export function generatedName(name: string, suffix: string): string {
    return `__${name}${suffix}`
}

// A type-parameter name based on `baseName` that does not collide with the class's own
// type parameters; `_1`, `_2`, … are appended until it is unique. Used for the synthetic
// diagnostic-carrier type parameters appended to generated `$base` declarations.
export function uniqueTypeParameterName(
    declaration: ts.ClassDeclaration,
    baseName: string
): string {
    const existing = new Set(declaration.typeParameters?.map((typeParameter) => typeParameter.name.text) ?? [])
    let name       = baseName
    let index      = 0

    while (existing.has(name)) {
        index++
        name = `${baseName}_${index}`
    }

    return name
}
