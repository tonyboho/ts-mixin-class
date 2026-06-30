import type * as ts from "typescript"
import {
    isNamedClassElement,
    type MixinDeclarationDiagnostic
} from "./model.js"
import { hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

export function collectMixinClassDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration
): MixinDeclarationDiagnostic[] {
    const diagnostics: MixinDeclarationDiagnostic[] = []
    const className                                 = declaration.name?.text ?? "<anonymous mixin>"

    if (hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.AbstractKeyword)) {
        diagnostics.push({
            node    : declaration,
            message : "Invalid mixin class declaration. " +
                `Mixin class ${className} cannot be abstract. ` +
                "Mixin classes are concrete runtime factories; remove the abstract modifier and provide concrete members."
        })
    }

    for (const member of declaration.members) {
        // A `@mixin` MAY declare its own constructor: the runtime factory preserves it (with a
        // synthetic `super()`), so `new` on a base-less mixin runs it, and `.new()` runs it as the
        // native-construct step for a construction mixin. Only the direct `new` CALL on a
        // construction (Base-derived) class is guarded, elsewhere — never the declaration.
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword)
        ) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "cannot be private or protected. Mixin members must be public because they are copied into generated structural interfaces."
            })
        }

        if (isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "cannot use ECMAScript private names. Mixin classes are structurally composed, and #private fields cannot be represented in the generated mixin interface."
            })
        }

        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword)) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "cannot be abstract. Mixin runtime factories need concrete member implementations."
            })
        }

        if (tsInstance.isPropertyDeclaration(member) && member.type === undefined) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} property ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "must have an explicit type annotation. The transformer needs an explicit type to generate the public mixin interface."
            })
        }

        if (tsInstance.isMethodDeclaration(member)) {
            if (member.type === undefined) {
                diagnostics.push({
                    node    : member,
                    message : "Invalid mixin class declaration. " +
                        `Mixin class ${className} method ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                        "must have an explicit return type annotation. The transformer needs an explicit return type to generate the public mixin interface."
                })
            }

            for (const parameter of member.parameters) {
                if (parameter.type === undefined) {
                    diagnostics.push({
                        node    : parameter,
                        message : "Invalid mixin class declaration. " +
                            `Mixin class ${className} method parameter ${parameterNameForDiagnostic(tsInstance, sourceFile, parameter)} ` +
                            "must have an explicit type annotation. The transformer needs explicit parameter types to generate the public mixin interface."
                    })
                }
            }
        }

        if (tsInstance.isGetAccessorDeclaration(member) || tsInstance.isSetAccessorDeclaration(member)) {
            const accessorType = tsInstance.isGetAccessorDeclaration(member)
                ? member.type
                : member.parameters[0]?.type

            if (accessorType === undefined) {
                diagnostics.push({
                    node    : member,
                    message : "Invalid mixin class declaration. " +
                        `Mixin class ${className} accessor ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                        "must have an explicit type annotation. Add a getter return type or a setter parameter type so the transformer can generate the public mixin interface."
                })
            }
        }

        if (!isSupportedMixinClassMember(tsInstance, member)) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} member ${memberNameForDiagnostic(tsInstance, sourceFile, member)} ` +
                    "is not supported by the mixin transformer. Use fields, methods, or accessors with explicit public types."
            })
        }
    }

    return diagnostics
}

export function isSupportedMixinClassMember(tsInstance: TypeScript, member: ts.ClassElement): boolean {
    return tsInstance.isConstructorDeclaration(member) ||
        tsInstance.isPropertyDeclaration(member) ||
        tsInstance.isMethodDeclaration(member) ||
        tsInstance.isGetAccessorDeclaration(member) ||
        tsInstance.isSetAccessorDeclaration(member) ||
        // Index signatures (`[key: string]: T`) are type-only — copied into the generated
        // mixin interface, erased at runtime. Supported so a mixin can declare a dynamic
        // member shape.
        tsInstance.isIndexSignatureDeclaration(member) ||
        tsInstance.isSemicolonClassElement(member) ||
        hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword)
}

function memberNameForDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    member: ts.ClassElement
): string {
    const name = member.name

    if (name === undefined) {
        return "constructor"
    }

    if (tsInstance.isPrivateIdentifier(name)) {
        return name.text
    }

    if (tsInstance.isIdentifier(name) || tsInstance.isStringLiteral(name) || tsInstance.isNumericLiteral(name)) {
        return name.text
    }

    return name.getText(sourceFile)
}

function parameterNameForDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    parameter: ts.ParameterDeclaration
): string {
    if (tsInstance.isIdentifier(parameter.name)) {
        return parameter.name.text
    }

    return parameter.name.getText(sourceFile)
}
