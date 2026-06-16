import type * as ts from "typescript"
import {
    anyConstructorName,
    implementsTypes,
    mixinApplicationName,
    requiredBaseType
} from "./model.js"
import { heritageTypeToTypeReference } from "./expand-util.js"
import { deepCloneNode, hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

const manualMixinApplySyntaxCache = new WeakMap<ts.SourceFile, boolean>()

// Result depends only on the (immutable) file text, but the source-view metadata
// base is built once per mixin, so memoize per file to avoid rescanning the whole
// text for every mixin declaration in the file.
export function hasManualMixinApplySyntax(sourceFile: ts.SourceFile): boolean {
    const cached = manualMixinApplySyntaxCache.get(sourceFile)

    if (cached !== undefined) {
        return cached
    }

    const result = /\.mix\s*(?:<|\()/.test(sourceFile.text)

    manualMixinApplySyntaxCache.set(sourceFile, result)

    return result
}

export function createSourceViewMixinApplyType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    typeParameters: ts.TypeParameterDeclaration[] | undefined
): ts.TypeLiteralNode {
    return createMixinApplyType(
        tsInstance,
        declaration,
        typeParameters,
        createSourceViewMixinInstanceType(tsInstance, declaration),
        createSourceViewMixinStaticsType(tsInstance, declaration)
    )
}

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
    const baseConstraint        = factory.createTypeReferenceNode(anyConstructorName, [
        requiredBase === undefined
            ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            : heritageTypeToTypeReference(tsInstance, requiredBase)
    ])

    return factory.createTypeLiteralNode([
        factory.createPropertySignature(
            [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ],
            "mix",
            undefined,
            factory.createFunctionTypeNode(
                [
                    ...(typeParameters?.map((typeParameter) => {
                        return deepCloneNode(tsInstance, typeParameter)
                    }) ?? []),
                    factory.createTypeParameterDeclaration(
                        undefined,
                        baseTypeParameterName,
                        baseConstraint,
                        undefined
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

function createSourceViewMixinInstanceType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeNode {
    const factory        = tsInstance.factory
    const ownType        = factory.createTypeLiteralNode(createSourceViewMixinInstanceMembers(tsInstance, declaration))
    const inheritedTypes = [
        ...(requiredBaseType(tsInstance, declaration) === undefined
            ? []
            : [ heritageTypeToTypeReference(tsInstance, requiredBaseType(tsInstance, declaration)!) ]),
        ...implementsTypes(tsInstance, declaration).map((heritageType) => {
            return heritageTypeToTypeReference(tsInstance, heritageType)
        })
    ]

    if (inheritedTypes.length === 0) {
        return ownType
    }

    return factory.createIntersectionTypeNode([ ...inheritedTypes, ownType ])
}

function createSourceViewMixinInstanceMembers(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeElement[] {
    const factory = tsInstance.factory

    return declaration.members.flatMap((member): ts.TypeElement[] => {
        if (
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
            member.name === undefined ||
            tsInstance.isPrivateIdentifier(member.name)
        ) {
            return []
        }

        if (tsInstance.isPropertyDeclaration(member)) {
            return [ factory.createPropertySignature(
                !hasModifier(tsInstance, member, tsInstance.SyntaxKind.ReadonlyKeyword)
                    ? undefined
                    : [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ],
                deepCloneNode(tsInstance, member.name),
                member.questionToken === undefined ? undefined : deepCloneNode(tsInstance, member.questionToken),
                member.type === undefined
                    ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                    : deepCloneNode(tsInstance, member.type)
            ) ]
        }

        if (tsInstance.isMethodDeclaration(member)) {
            return [ factory.createMethodSignature(
                undefined,
                deepCloneNode(tsInstance, member.name),
                member.questionToken === undefined ? undefined : deepCloneNode(tsInstance, member.questionToken),
                member.typeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter)),
                member.parameters.map((parameter) => createSourceViewSignatureParameter(tsInstance, parameter)),
                member.type === undefined
                    ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                    : deepCloneNode(tsInstance, member.type)
            ) ]
        }

        return []
    })
}

function createSourceViewMixinStaticsType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeLiteralNode {
    return tsInstance.factory.createTypeLiteralNode(declaration.members.flatMap((member): ts.TypeElement[] => {
        if (!hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) || member.name === undefined) {
            return []
        }

        if (tsInstance.isPropertyDeclaration(member) && !tsInstance.isPrivateIdentifier(member.name)) {
            return [ tsInstance.factory.createPropertySignature(
                undefined,
                deepCloneNode(tsInstance, member.name),
                member.questionToken === undefined ? undefined : deepCloneNode(tsInstance, member.questionToken),
                member.type === undefined
                    ? tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                    : deepCloneNode(tsInstance, member.type)
            ) ]
        }

        if (tsInstance.isMethodDeclaration(member) && !tsInstance.isPrivateIdentifier(member.name)) {
            return [ tsInstance.factory.createMethodSignature(
                undefined,
                deepCloneNode(tsInstance, member.name),
                member.questionToken === undefined ? undefined : deepCloneNode(tsInstance, member.questionToken),
                member.typeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter)),
                member.parameters.map((parameter) => createSourceViewSignatureParameter(tsInstance, parameter)),
                member.type === undefined
                    ? tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                    : deepCloneNode(tsInstance, member.type)
            ) ]
        }

        return []
    }))
}

function createSourceViewSignatureParameter(
    tsInstance: TypeScript,
    parameter: ts.ParameterDeclaration
): ts.ParameterDeclaration {
    return tsInstance.factory.createParameterDeclaration(
        undefined,
        parameter.dotDotDotToken === undefined ? undefined : deepCloneNode(tsInstance, parameter.dotDotDotToken),
        deepCloneNode(tsInstance, parameter.name),
        parameter.questionToken === undefined ? undefined : deepCloneNode(tsInstance, parameter.questionToken),
        parameter.type === undefined
            ? tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            : deepCloneNode(tsInstance, parameter.type),
        undefined
    )
}

function mixinApplyBaseTypeParameterName(declaration: ts.ClassDeclaration): string {
    const usedNames = new Set(declaration.typeParameters?.map((typeParameter) => typeParameter.name.text) ?? [])
    let name        = "__MixinBase"

    while (usedNames.has(name)) {
        name = `_${name}`
    }

    return name
}
