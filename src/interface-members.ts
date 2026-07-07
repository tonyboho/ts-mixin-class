import type * as ts from "typescript"
import { isNamedClassElement } from "./model.js"
import { cloneNode, cloneOptionalNode, cloneOptionalNodeArray, hasModifier } from "./util.js"
import { preserveTextRange, zeroWidthRange } from "./text-range.js"
import type { TypeScript } from "./util.js"

export function buildInterfaceMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration
): ts.NodeArray<ts.TypeElement> {
    const factory                   = tsInstance.factory
    const members: ts.TypeElement[] = []

    const getters = new Map<string, ts.GetAccessorDeclaration>()
    const setters = new Map<string, ts.SetAccessorDeclaration>()

    for (const member of declaration.members) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword)) {
            continue
        }

        if (tsInstance.isGetAccessorDeclaration(member)) {
            getters.set(memberNameText(tsInstance, sourceFile, member), member)
        }

        if (tsInstance.isSetAccessorDeclaration(member)) {
            setters.set(memberNameText(tsInstance, sourceFile, member), member)
        }
    }

    const emittedAccessors = new Set<string>()

    for (const member of declaration.members) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
            tsInstance.isSemicolonClassElement(member)
        ) {
            continue
        }

        if (tsInstance.isConstructorDeclaration(member)) {
            // A PARAMETER PROPERTY (`constructor(public label: string = …)`) declares a real
            // instance member — surface it as a property signature like a declared field.
            // Overload signatures cannot carry parameter properties, so only the
            // implementation's parameters match.
            for (const parameter of member.parameters) {
                if (!tsInstance.isParameterPropertyDeclaration(parameter, member) ||
                    hasModifier(tsInstance, parameter, tsInstance.SyntaxKind.PrivateKeyword) ||
                    hasModifier(tsInstance, parameter, tsInstance.SyntaxKind.ProtectedKeyword) ||
                    !tsInstance.isIdentifier(parameter.name)
                ) {
                    continue
                }

                members.push(preserveTextRange(tsInstance, factory.createPropertySignature(
                    hasModifier(tsInstance, parameter, tsInstance.SyntaxKind.ReadonlyKeyword)
                        ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ]
                        : undefined,
                    cloneNode(tsInstance, parameter.name),
                    cloneOptionalNode(tsInstance, parameter.questionToken),
                    clonedTypeOrAny(tsInstance, parameter.type)
                ), parameterSignatureRange(parameter)))
            }

            continue
        }

        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) ||
            isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)
        ) {
            continue
        }

        if (tsInstance.isPropertyDeclaration(member)) {
            // An AUTO-ACCESSOR (`accessor x: T`) is syntactically a PropertyDeclaration but at
            // runtime a real get/set pair on the prototype — surface it as REAL signatures
            // (§1.27), not a property signature, so its accessor-ness survives into the
            // consumer's type (and the member-kind guard stays consistent — §2.14).
            // A this-typed auto-accessor keeps the plain property signature below — the same
            // upstream-crash workaround as accessorSignatures.
            if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.AccessorKeyword) &&
                !containsThisType(tsInstance, member.type)
            ) {
                members.push(
                    preserveTextRange(tsInstance, factory.createGetAccessorDeclaration(
                        undefined,
                        cloneNode(tsInstance, member.name),
                        [],
                        clonedTypeOrAny(tsInstance, member.type),
                        undefined
                    ) as ts.TypeElement, interfaceMemberRange(member)),
                    preserveTextRange(tsInstance, factory.createSetAccessorDeclaration(
                        undefined,
                        cloneNode(tsInstance, member.name),
                        [ factory.createParameterDeclaration(
                            undefined, undefined, "value", undefined,
                            clonedTypeOrAny(tsInstance, member.type), undefined
                        ) ],
                        undefined
                    ) as ts.TypeElement, interfaceMemberRange(member))
                )
                continue
            }

            members.push(preserveTextRange(tsInstance, factory.createPropertySignature(
                hasModifier(tsInstance, member, tsInstance.SyntaxKind.ReadonlyKeyword)
                    ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ]
                    : undefined,
                cloneNode(tsInstance, member.name),
                cloneOptionalNode(tsInstance, member.questionToken),
                clonedTypeOrAny(tsInstance, member.type)
            ), interfaceMemberRange(member)))
            continue
        }

        if (tsInstance.isMethodDeclaration(member)) {
            members.push(preserveTextRange(tsInstance, factory.createMethodSignature(
                undefined,
                cloneNode(tsInstance, member.name),
                cloneOptionalNode(tsInstance, member.questionToken),
                cloneOptionalNodeArray(tsInstance, member.typeParameters),
                member.parameters.map((parameter) => signatureParameter(tsInstance, parameter)),
                clonedTypeOrAny(tsInstance, member.type)
            ), interfaceMemberRange(member)))
            continue
        }

        if (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) {
            const name = memberNameText(tsInstance, sourceFile, member)

            if (emittedAccessors.has(name)) {
                continue
            }

            emittedAccessors.add(name)

            members.push(...accessorSignatures(tsInstance, member, getters.get(name), setters.get(name)))
            continue
        }

        if (tsInstance.isIndexSignatureDeclaration(member)) {
            members.push(preserveTextRange(tsInstance, factory.createIndexSignature(
                hasModifier(tsInstance, member, tsInstance.SyntaxKind.ReadonlyKeyword)
                    ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ]
                    : undefined,
                member.parameters.map((parameter) => signatureParameter(tsInstance, parameter)),
                cloneNode(tsInstance, member.type)
            ), interfaceMemberRange(member)))
            continue
        }

        continue
    }

    const membersRange = members.length === 0
        ? zeroWidthRange(declaration.name?.end ?? declaration.end)
        : {
            pos : members[0].pos,
            end : members.at(-1)!.end
        }

    return preserveTextRange(tsInstance, factory.createNodeArray(members), membersRange)
}

// The cooperative-construction `initialize` protocol signature, identical to
// `Base.initialize(props?: unknown): void`. Re-declared on a generated `$base`
// interface (consumer or construction mixin) that extends `Base` plus mixins overriding
// `initialize` with their own strict `<Mixin>Config`, so the non-identical inherited
// members do not collide via interface merge (TS2320). An own member overrides the
// conflicting inherited ones; the source class keeps its strict override body.
export function constructionProtocolInitializeSignature(tsInstance: TypeScript): ts.MethodSignature {
    const factory = tsInstance.factory

    return factory.createMethodSignature(
        undefined,
        "initialize",
        undefined,
        undefined,
        [ factory.createParameterDeclaration(
            undefined,
            undefined,
            "props",
            factory.createToken(tsInstance.SyntaxKind.QuestionToken),
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword),
            undefined
        ) ],
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.VoidKeyword)
    )
}

// Whether the class declares its own instance `initialize` method. When it does, that
// override already overrides any conflicting inherited `initialize`, so the generated
// `$base` interface must NOT also inject the protocol member (a duplicate would error).
export function declaresInstanceInitialize(tsInstance: TypeScript, declaration: ts.ClassDeclaration): boolean {
    return declaration.members.some((member) =>
        tsInstance.isMethodDeclaration(member) &&
        tsInstance.isIdentifier(member.name) &&
        member.name.text === "initialize" &&
        !hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword))
}

export function interfaceDeclarationRange(
    declaration: ts.ClassDeclaration,
    members: ts.NodeArray<ts.TypeElement>
): ts.TextRange {
    return {
        pos : declaration.pos,
        end : Math.max(declaration.name?.end ?? declaration.end, members.end)
    }
}

// Real `get` / `set` signatures (TS 4.3+ interface accessors), NOT a property signature: the
// accessor-ness must survive into the generated interface so the checker keeps the plain-TS
// guards a class base would give — a consumer FIELD shadowing a mixin accessor is TS2610 under
// define semantics (`useDefineForClassFields: true`), exactly as with ordinary inheritance —
// and a SPLIT pair keeps its distinct read/write types.
function accessorSignatures(
    tsInstance: TypeScript,
    member: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
    getter: ts.GetAccessorDeclaration | undefined,
    setter: ts.SetAccessorDeclaration | undefined
): ts.TypeElement[] {
    const factory                      = tsInstance.factory
    const signatures: ts.TypeElement[] = []

    // WORKAROUND for an upstream TypeScript checker CRASH (verified on 6.0.3, plain TS — no
    // transform involved), reported as https://github.com/microsoft/TypeScript/issues/63619:
    // a `this` type anywhere inside an INTERFACE accessor's annotation
    // (`interface I { get self(): this }`, nested positions included) makes
    // `getTypeFromThisTypeNode` return undefined and `getConditionalFlowTypeOfType` throws.
    // A method signature and a PROPERTY signature with the same `this` type are fine — so a
    // this-typed accessor falls back to the pre-§1.27 property form (narrowing at the consumer
    // is identical; only the accessor-ness and a split pair's write type are collapsed).
    // Removable only when every supported TS version carries the upstream fix — as long as an
    // affected version (6.0.3) stays supported, the fallback stays.
    if (containsThisType(tsInstance, getter?.type) ||
        containsThisType(tsInstance, setter?.parameters[0]?.type)
    ) {
        const propertyType = getter?.type ?? setter?.parameters[0]?.type

        return [ preserveTextRange(tsInstance, factory.createPropertySignature(
            getter !== undefined && setter === undefined
                ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ]
                : undefined,
            cloneNode(tsInstance, member.name),
            undefined,
            clonedTypeOrAny(tsInstance, propertyType)
        ), interfaceMemberRange(getter ?? member)) ]
    }

    if (getter !== undefined) {
        signatures.push(preserveTextRange(tsInstance, factory.createGetAccessorDeclaration(
            undefined,
            cloneNode(tsInstance, member.name),
            [],
            clonedTypeOrAny(tsInstance, getter.type),
            undefined
        ) as ts.TypeElement, interfaceMemberRange(getter)))
    }

    if (setter !== undefined) {
        // A setter without its parameter is already invalid TS — the `any` fallback only keeps
        // a broken declaration from crashing the transform.
        const parameter = setter.parameters[0] !== undefined
            ? signatureParameter(tsInstance, setter.parameters[0])
            : factory.createParameterDeclaration(
                undefined, undefined, "value", undefined,
                factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword), undefined
            )

        signatures.push(preserveTextRange(tsInstance, factory.createSetAccessorDeclaration(
            undefined,
            cloneNode(tsInstance, member.name),
            [ parameter ],
            undefined
        ) as ts.TypeElement, interfaceMemberRange(setter)))
    }

    return signatures
}

// Whether a `this` type appears anywhere inside `type` (see the upstream-crash workaround in
// `accessorSignatures`).
function containsThisType(tsInstance: TypeScript, type: ts.TypeNode | undefined): boolean {
    if (type === undefined) {
        return false
    }

    if (type.kind === tsInstance.SyntaxKind.ThisType) {
        return true
    }

    let found = false

    const visit = (node: ts.Node): void => {
        if (found) {
            return
        }

        if (node.kind === tsInstance.SyntaxKind.ThisType) {
            found = true
            return
        }

        tsInstance.forEachChild(node, visit)
    }

    tsInstance.forEachChild(type, visit)

    return found
}

// A cloned copy of `type`, or the `any` keyword when the source omitted it. The mixin
// validator already requires explicit annotations, so the `any` fallback is only a
// belt-and-braces default for members that slip through (e.g. on a broken declaration).
function clonedTypeOrAny(
    tsInstance: TypeScript,
    type: ts.TypeNode | undefined
): ts.TypeNode {
    return cloneOptionalNode(tsInstance, type) ??
        tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
}

function signatureParameter(
    tsInstance: TypeScript,
    parameter: ts.ParameterDeclaration
): ts.ParameterDeclaration {
    // A signature parameter with an initializer becomes optional.
    return preserveTextRange(tsInstance, tsInstance.factory.createParameterDeclaration(
        undefined,
        cloneOptionalNode(tsInstance, parameter.dotDotDotToken),
        cloneNode(tsInstance, parameter.name),
        parameter.initializer === undefined
            ? cloneOptionalNode(tsInstance, parameter.questionToken)
            : tsInstance.factory.createToken(tsInstance.SyntaxKind.QuestionToken),
        clonedTypeOrAny(tsInstance, parameter.type),
        undefined
    ), parameterSignatureRange(parameter))
}

function interfaceMemberRange(member: ts.ClassElement): ts.TextRange {
    if (isTypedClassElement(member)) {
        return {
            pos : member.pos,
            end : member.type.end
        }
    }

    return {
        pos : member.pos,
        end : member.end
    }
}

function isTypedClassElement(member: ts.ClassElement): member is ts.ClassElement & { type: ts.TypeNode } {
    return "type" in member && member.type !== undefined
}

function parameterSignatureRange(parameter: ts.ParameterDeclaration): ts.TextRange {
    return {
        pos : parameter.pos,
        end : parameter.type?.end ?? parameter.name.end
    }
}

function memberNameText(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    member: ts.ClassElement
): string {
    const name = member.name

    if (name !== undefined && (tsInstance.isIdentifier(name) || tsInstance.isStringLiteral(name))) {
        return name.text
    }

    return name?.getText(sourceFile) ?? "constructor"
}
