import type * as ts from "typescript"
import { propertyNameText, type FillMissedInitializersWith, type TransformOptions } from "./model.js"
import { hasModifier, preserveTextRange } from "./util.js"
import type { TypeScript } from "./util.js"

// Give every construction-class field a value, so each instance keeps a stable object shape
// (monomorphic property access — see TODO "Always emit field initializers"). A field with no
// source initializer is filled with the configured value; the value is a non-null assertion
// (`undefined!` / `null!`, type `never`) so the property type is never widened, and it prints
// to `.js` as a plain `field = undefined` / `field = null`. Adding an initializer also strips a
// definite-assignment `!` (a `!` field with an initializer is illegal — TS1263).
export function fillMissedInitializers(
    tsInstance: TypeScript,
    members: ts.NodeArray<ts.ClassElement>,
    options: TransformOptions
): ts.NodeArray<ts.ClassElement> {
    const fill = options.fillMissedInitializersWith

    if (fill === "nothing") {
        return members
    }

    let changed            = false
    const rewrittenMembers = members.map((member) => {
        const rewrittenMember = fillMissedInitializer(tsInstance, member, fill)

        if (rewrittenMember !== member) {
            changed = true
        }

        return rewrittenMember
    })

    return changed
        ? preserveTextRange(tsInstance, tsInstance.factory.createNodeArray(rewrittenMembers), members)
        : members
}

export function fillMissedInitializersClass(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    options: TransformOptions
): ts.ClassDeclaration {
    const members = fillMissedInitializers(tsInstance, declaration.members, options)

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

function fillMissedInitializer(
    tsInstance: TypeScript,
    member: ts.ClassElement,
    fill: Exclude<FillMissedInitializersWith, "nothing">
): ts.ClassElement {
    if (!isFillableProperty(tsInstance, member)) {
        return member
    }

    const fillKeyword = fill === "null" ? "null" : "undefined"

    // Only fill a missing initializer, or normalize an existing bare `undefined` / `null` that
    // would otherwise fail to assign to a non-nullable type. A real initializer is left intact.
    if (member.initializer !== undefined && !isBareFillKeyword(tsInstance, member.initializer, fillKeyword)) {
        return member
    }

    const fillExpression = fill === "null"
        ? tsInstance.factory.createNull()
        : tsInstance.factory.createIdentifier("undefined")

    const filledInitializer = member.initializer === undefined
        ? tsInstance.factory.createNonNullExpression(fillExpression)
        : preserveTextRange(
            tsInstance,
            tsInstance.factory.createNonNullExpression(fillExpression),
            member.initializer
        )

    return preserveTextRange(tsInstance, tsInstance.factory.updatePropertyDeclaration(
        member,
        member.modifiers,
        member.name,
        // Keep an optional `?` marker; drop a definite-assignment `!`, since the property now
        // carries an initializer (a `!` field with an initializer is illegal).
        member.questionToken,
        member.type,
        filledInitializer
    ), member)
}

function isBareFillKeyword(
    tsInstance: TypeScript,
    expression: ts.Expression,
    fillKeyword: "undefined" | "null"
): boolean {
    return fillKeyword === "null"
        ? expression.kind === tsInstance.SyntaxKind.NullKeyword
        : tsInstance.isIdentifier(expression) && expression.text === "undefined"
}

function isFillableProperty(
    tsInstance: TypeScript,
    member: ts.ClassElement
): member is ts.PropertyDeclaration & { type: ts.TypeNode } {
    return tsInstance.isPropertyDeclaration(member) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) &&
        hasModifier(tsInstance, member, tsInstance.SyntaxKind.PublicKeyword) &&
        member.type !== undefined &&
        propertyNameText(tsInstance, member.name) !== undefined
}
