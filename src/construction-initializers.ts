import type * as ts from "typescript"
import { propertyNameText, type TransformOptions } from "./model.js"
import { hasModifier, preserveTextRange } from "./util.js"
import type { TypeScript } from "./util.js"

export function rewritePublicOnlyUndefinedInitializers(
    tsInstance: TypeScript,
    members: ts.NodeArray<ts.ClassElement>,
    options: TransformOptions
): ts.NodeArray<ts.ClassElement> {
    if (!shouldRewritePublicOnlyUndefinedInitializers(options)) {
        return members
    }

    let changed            = false
    const rewrittenMembers = members.map((member) => {
        const rewrittenMember = rewritePublicOnlyUndefinedInitializer(tsInstance, member)

        if (rewrittenMember !== member) {
            changed = true
        }

        return rewrittenMember
    })

    return changed
        ? preserveTextRange(tsInstance, tsInstance.factory.createNodeArray(rewrittenMembers), members)
        : members
}

export function rewritePublicOnlyUndefinedInitializerClass(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    options: TransformOptions
): ts.ClassDeclaration {
    const members = rewritePublicOnlyUndefinedInitializers(tsInstance, declaration.members, options)

    if (members === declaration.members) {
        return declaration
    }

    return preserveTextRange(tsInstance, tsInstance.factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        declaration.heritageClauses,
        members
    ), declaration)
}

function shouldRewritePublicOnlyUndefinedInitializers(options: TransformOptions): boolean {
    return options.constructionConfig === "public-only" &&
        options.allowUndefinedForRequiredProperties
}

function rewritePublicOnlyUndefinedInitializer(
    tsInstance: TypeScript,
    member: ts.ClassElement
): ts.ClassElement {
    if (!isPublicOnlyUndefinedInitializer(tsInstance, member)) {
        return member
    }

    return preserveTextRange(tsInstance, tsInstance.factory.updatePropertyDeclaration(
        member,
        member.modifiers,
        member.name,
        member.questionToken ?? member.exclamationToken,
        member.type,
        preserveTextRange(
            tsInstance,
            tsInstance.factory.createNonNullExpression(tsInstance.factory.createIdentifier("undefined")),
            member.initializer
        )
    ), member)
}

function isPublicOnlyUndefinedInitializer(
    tsInstance: TypeScript,
    member: ts.ClassElement
): member is ts.PropertyDeclaration & { initializer: ts.Identifier, type: ts.TypeNode } {
    return tsInstance.isPropertyDeclaration(member) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) &&
        hasModifier(tsInstance, member, tsInstance.SyntaxKind.PublicKeyword) &&
        member.questionToken === undefined &&
        member.type !== undefined &&
        member.initializer !== undefined &&
        tsInstance.isIdentifier(member.initializer) &&
        member.initializer.text === "undefined" &&
        propertyNameText(tsInstance, member.name) !== undefined
}
