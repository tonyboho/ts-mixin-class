import type * as ts from "typescript"
import { isNamedClassElement } from "./model.js"
import {
    cloneNode,
    cloneOptionalNode,
    cloneOptionalNodeArray,
    hasModifier,
    preserveTextRange,
    zeroWidthRange
} from "./util.js"
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

        if (tsInstance.isConstructorDeclaration(member) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) ||
            isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)
        ) {
            continue
        }

        if (tsInstance.isPropertyDeclaration(member)) {
            members.push(preserveTextRange(tsInstance, factory.createPropertySignature(
                hasModifier(tsInstance, member, tsInstance.SyntaxKind.ReadonlyKeyword)
                    ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ]
                    : undefined,
                cloneNode(tsInstance, member.name),
                cloneOptionalNode(tsInstance, member.questionToken),
                cloneOptionalNode(tsInstance, member.type) ??
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
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
                cloneOptionalNode(tsInstance, member.type) ??
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            ), interfaceMemberRange(member)))
            continue
        }

        if (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) {
            const name = memberNameText(tsInstance, sourceFile, member)

            if (emittedAccessors.has(name)) {
                continue
            }

            emittedAccessors.add(name)

            members.push(accessorSignature(tsInstance, sourceFile, member, getters.get(name), setters.get(name)))
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

function accessorSignature(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    member: ts.GetAccessorDeclaration | ts.SetAccessorDeclaration,
    getter: ts.GetAccessorDeclaration | undefined,
    setter: ts.SetAccessorDeclaration | undefined
): ts.PropertySignature {
    const factory = tsInstance.factory

    const type =
        getter?.type ??
        (setter !== undefined && setter.parameters.length > 0 ? setter.parameters[0].type : undefined)

    return preserveTextRange(tsInstance, factory.createPropertySignature(
        setter === undefined ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ] : undefined,
        cloneNode(tsInstance, member.name),
        undefined,
        cloneOptionalNode(tsInstance, type) ??
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
    ), interfaceMemberRange(member))
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
        cloneOptionalNode(tsInstance, parameter.type) ??
            tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword),
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
