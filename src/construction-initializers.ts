import type * as ts from "typescript"
import { propertyNameText, type FillMissedInitializersWith, type TransformOptions } from "./model.js"
import { hasModifier, preserveTextRange } from "./util.js"
import type { TypeScript } from "./util.js"

// Normalize a construction class's public field initializers. Two concerns, both about giving
// every instance a stable object shape and keeping the new `!`-required-config convention legal:
//
//   1. Fill (option `fillMissedInitializersWith`, default "undefined"): a field with no source
//      initializer is given one, so the slot exists on every instance (monomorphic property
//      access). The value is a non-null assertion (`undefined!` / `null!`, type `never`) so the
//      property type is never widened, and prints to `.js` as plain `field = undefined`/`= null`.
//      "nothing" disables filling.
//   2. Definite-assignment `!`: a `public id!: T` field marks a REQUIRED config key. TypeScript
//      forbids an initializer on a `!` field (TS1263), so whenever the field ends up with an
//      initializer (filled, or one the user wrote), the `!` is stripped — leaving a clean
//      `id: T = ...`. This strip runs even when filling is "nothing", so `id!: T = init` always
//      compiles. A `!` field left with no initializer keeps its `!` (it satisfies strict-init).
export function fillMissedInitializers(
    tsInstance: TypeScript,
    members: ts.NodeArray<ts.ClassElement>,
    options: TransformOptions
): ts.NodeArray<ts.ClassElement> {
    const fill = options.fillMissedInitializersWith

    let changed            = false
    const rewrittenMembers = members.map((member) => {
        const rewrittenMember = normalizeFieldInitializer(tsInstance, member, fill)

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

function normalizeFieldInitializer(
    tsInstance: TypeScript,
    member: ts.ClassElement,
    fill: FillMissedInitializersWith
): ts.ClassElement {
    if (!isFillableProperty(tsInstance, member)) {
        return member
    }

    const fillKeyword  = fill === "null" ? "null" : "undefined"
    const fillEnabled  = fill !== "nothing"
    const hasInitiator = member.initializer !== undefined

    if (hasInitiator) {
        // Normalize a bare `= undefined` / `= null` that would not assign to a non-nullable type
        // into the `<keyword>!` form; otherwise keep the real initializer, only stripping a `!`.
        const replaceWithFill = fillEnabled &&
            isBareFillKeyword(tsInstance, member.initializer, fillKeyword)

        if (!replaceWithFill && member.exclamationToken === undefined) {
            return member
        }

        const initializer = replaceWithFill
            ? preserveTextRange(tsInstance, createFillExpression(tsInstance, fillKeyword), member.initializer)
            : member.initializer

        return rebuildPropertyWithInitializer(tsInstance, member, initializer)
    }

    // No initializer: fill it (unless "nothing"); a `!` field with no initializer keeps its `!`.
    if (!fillEnabled) {
        return member
    }

    return rebuildPropertyWithInitializer(tsInstance, member, createFillExpression(tsInstance, fillKeyword))
}

// Rebuild the property with the given initializer, dropping a definite-assignment `!` (illegal
// alongside an initializer) while keeping an optional `?` — they are mutually exclusive, so
// `member.questionToken` is the only token that can survive.
function rebuildPropertyWithInitializer(
    tsInstance: TypeScript,
    member: ts.PropertyDeclaration,
    initializer: ts.Expression
): ts.PropertyDeclaration {
    return preserveTextRange(tsInstance, tsInstance.factory.updatePropertyDeclaration(
        member,
        member.modifiers,
        member.name,
        member.questionToken,
        member.type,
        initializer
    ), member)
}

function createFillExpression(
    tsInstance: TypeScript,
    fillKeyword: "undefined" | "null"
): ts.NonNullExpression {
    const value = fillKeyword === "null"
        ? tsInstance.factory.createNull()
        : tsInstance.factory.createIdentifier("undefined")

    return tsInstance.factory.createNonNullExpression(value)
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

// Fill targets EVERY instance field, not just public/config ones — a stable object shape is a
// runtime concern independent of visibility (`private`/`protected`/unmarked all benefit). The
// exclusions are the fields that genuinely cannot or should not be filled:
//   - `static` — not an instance field, so irrelevant to instance object shape;
//   - `abstract` / `declare` — cannot carry an initializer;
//   - no type annotation — `undefined!` (type `never`) would change the field's inferred type;
//   - computed / `#private` names (no `propertyNameText`) — left out of scope for now.
function isFillableProperty(
    tsInstance: TypeScript,
    member: ts.ClassElement
): member is ts.PropertyDeclaration & { type: ts.TypeNode } {
    return tsInstance.isPropertyDeclaration(member) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword) &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.DeclareKeyword) &&
        member.type !== undefined &&
        propertyNameText(tsInstance, member.name) !== undefined
}
