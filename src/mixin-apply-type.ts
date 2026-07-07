import type * as ts from "typescript"
import {
    anyConstructorName,
    mixinApplicationName,
    requiredBaseType
} from "./model.js"
import { heritageTypeToTypeReference } from "./expand-util.js"
import { deepCloneNode, stripVarianceAnnotations } from "./util.js"
import type { TypeScript } from "./util.js"

export function createMixinApplyType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    typeParameters: ts.TypeParameterDeclaration[] | undefined,
    instanceType: ts.TypeNode,
    staticsType: ts.TypeNode
): ts.TypeLiteralNode {
    const factory               = tsInstance.factory
    const baseTypeParameterName = mixinApplyBaseTypeParameterName(declaration)
    const requiredBase          = requiredBaseType(tsInstance, declaration)
    // `AnyConstructor<requiredBase>` (or `<any>`). Built fresh per use so the same node is
    // never shared between the constraint and the default position.
    const baseConstraint = (): ts.TypeReferenceNode => factory.createTypeReferenceNode(anyConstructorName, [
        requiredBase === undefined
            ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            : heritageTypeToTypeReference(tsInstance, requiredBase)
    ])
    // `__MixinBase` normally stays a REQUIRED type parameter: that is what forces a caller
    // who supplies the mixin's own type arguments explicitly to also supply the base type
    // (otherwise the base would erase to `AnyConstructor<any>` — see §5.3). But TypeScript
    // forbids a required type parameter after an optional one, so when the mixin declares a
    // DEFAULTED own type parameter, `__MixinBase` must also become optional (TS2706 / §6.5);
    // we give it a default equal to its constraint. `.mix(base)` still infers it from the
    // argument in the common case, so the default is only a fallback.
    const ownTypeParametersHaveDefault = declaration.typeParameters?.some(
        (typeParameter) => typeParameter.default !== undefined
    ) ?? false

    return factory.createTypeLiteralNode([
        factory.createPropertySignature(
            [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ],
            "mix",
            undefined,
            factory.createFunctionTypeNode(
                [
                    ...(typeParameters?.map((typeParameter) => {
                        // A function-type position: variance annotations must not ride along (TS1274).
                        return stripVarianceAnnotations(tsInstance, deepCloneNode(tsInstance, typeParameter))
                    }) ?? []),
                    factory.createTypeParameterDeclaration(
                        undefined,
                        baseTypeParameterName,
                        baseConstraint(),
                        ownTypeParametersHaveDefault ? baseConstraint() : undefined
                    )
                ],
                [
                    factory.createParameterDeclaration(
                        undefined,
                        undefined,
                        "base",
                        undefined,
                        factory.createTypeReferenceNode(baseTypeParameterName, undefined)
                    )
                ],
                factory.createTypeReferenceNode(mixinApplicationName, [
                    factory.createTypeReferenceNode(baseTypeParameterName, undefined),
                    instanceType,
                    staticsType
                ])
            )
        )
    ])
}

function mixinApplyBaseTypeParameterName(declaration: ts.ClassDeclaration): string {
    const usedNames = new Set(declaration.typeParameters?.map((typeParameter) => typeParameter.name.text) ?? [])
    let name        = "__MixinBase"

    while (usedNames.has(name)) {
        name = `_${name}`
    }

    return name
}
