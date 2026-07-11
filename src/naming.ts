import type * as ts from "typescript"
import type { StaticCollisionCheckMode } from "./model.js"

// Every identifier the transform can generate or inject, in one place: the package's
// public helper names, their reserved double-underscore LOCAL aliases (so an injected
// import can never collide with a user binding, TS2440), the suffixes of the generated
// sibling declarations (`__X$mixin`, `__X$base`, ...), and the name builders on top.

export const anyConstructorName = "AnyConstructor"
export const classStaticsName = "ClassStatics"
export const defineMixinClassName = "defineMixinClass"
export const emptyName = "Empty"
export const mixinChainName = "mixinChain"
export const mixinChainLinearizedName = "mixinChainLinearized"
// The VALUE helpers are imported under reserved double-underscore LOCAL aliases so the injected
// import can never collide with a user binding of the package name (TS2440).
export const defineMixinClassLocalName = "__defineMixinClass__"
export const emptyLocalName = "__Empty__"
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
// The TYPE helpers ride the same reserved aliases: injected under their public names they
// would collide with a user's same-named declaration — or the user's own import of the
// helper — in the transformed file (TS2440 / TS2300), and silently re-bind the generated
// references to the user's type. Generated code references the LOCAL names only; the
// public names stay free for the user.
export const anyConstructorLocalName = "__AnyConstructor__"
export const classStaticsLocalName = "__ClassStatics__"
export const mixinApplicationLocalName = "__MixinApplication__"
export const mixinFactoryLocalName = "__MixinFactory__"
export const runtimeMixinClassLocalName = "__RuntimeMixinClass__"
export const mixinClassValueLocalName = "__MixinClassValue__"
export const constructionMixinClassValueLocalName = "__ConstructionMixinClassValue__"
export const staticNeverConflictKeysLocalName = "__StaticNeverConflictKeys__"
export const staticStrictConflictKeysLocalName = "__StaticStrictConflictKeys__"
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

export function staticConflictKeysLocalName(mode: Exclude<StaticCollisionCheckMode, false>): string {
    return mode === "strict" ? staticStrictConflictKeysLocalName : staticNeverConflictKeysLocalName
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
