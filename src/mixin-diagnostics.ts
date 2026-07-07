import type * as ts from "typescript"
import { dottedExpressionText } from "./expand-util.js"
import { resolveLexicalMixinRef } from "./mixin-refs.js"
import {
    isDeclarationFileName,
    isNamedClassElement,
    mixinDiagnosticCode,
    nativeDiagnosticOn,
    type FileMixinContext,
    type MixinDeclarationDiagnostic,
    type ResolvedMixinRef
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

        // `mix` is the ONLY reserved static on a mixin: `.mix(base)` is the framework's
        // application method, installed on every mixin class value by `defineMixinClass`.
        // `static new` is NOT reserved anywhere — a user's own `static new` OVERRIDES the
        // generated construction factory (`hasStaticNew` suppresses generation), on a mixin
        // exactly like on a plain construction class or a consumer.
        // `member.pos >= 0` skips synthetic (generated, position-less) members: the source-view
        // path can re-transform a class whose body already carries generated members, and a
        // position-less node would also crash the native-diagnostic span (`getStart`).
        if (member.pos >= 0 &&
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) &&
            isNamedClassElement(member) &&
            (tsInstance.isIdentifier(member.name) || tsInstance.isStringLiteral(member.name)) &&
            member.name.text === "mix"
        ) {
            diagnostics.push({
                node    : member,
                message : "Invalid mixin class declaration. " +
                    `Mixin class ${className} static member 'mix' is reserved. ` +
                    "The framework installs the mixin application method '.mix(base)' on every mixin class value. Rename the static member."
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

        if (tsInstance.isConstructorDeclaration(member)) {
            // A parameter property declares a real instance member, so it follows the same
            // rules as a declared field: public only, explicit type required.
            for (const parameter of member.parameters) {
                if (!tsInstance.isParameterPropertyDeclaration(parameter, member)) {
                    continue
                }

                if (hasModifier(tsInstance, parameter, tsInstance.SyntaxKind.PrivateKeyword) ||
                    hasModifier(tsInstance, parameter, tsInstance.SyntaxKind.ProtectedKeyword)
                ) {
                    diagnostics.push({
                        node    : parameter,
                        message : "Invalid mixin class declaration. " +
                            `Mixin class ${className} parameter property ${parameterNameForDiagnostic(tsInstance, sourceFile, parameter)} ` +
                            "cannot be private or protected. Mixin members must be public because they are copied into generated structural interfaces."
                    })
                }

                if (parameter.type === undefined) {
                    diagnostics.push({
                        node    : parameter,
                        message : "Invalid mixin class declaration. " +
                            `Mixin class ${className} parameter property ${parameterNameForDiagnostic(tsInstance, sourceFile, parameter)} ` +
                            "must have an explicit type annotation. The transformer needs an explicit type to generate the public mixin interface."
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
        // A `static {}` block stays in the factory class expression, so it runs once per
        // distinct base the mixin is applied over (memoized) — the same per-application
        // semantics static field initializers already have.
        tsInstance.isClassStaticBlockDeclaration(member) ||
        hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword)
}

function memberNameForDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    member: ts.ClassElement
): string {
    const name = member.name

    if (name === undefined) {
        // The nameless members: a constructor and a `static {}` initialization block. The latter
        // is rejected by `isSupportedMixinClassMember` (its side effects would re-run for every
        // chain application of the mixin factory), so its diagnostic must name it properly.
        return tsInstance.isClassStaticBlockDeclaration(member) ? "static initialization block" : "constructor"
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

// Manual `.mix(...)` on a PROGRAM-LOCAL mixin value is banned (native TS990012, both
// planes): inside a transformer program mixins compose through the class heritage
// (`extends Base implements Mixin`) — a manual application bypasses construction
// tracking and used to ride on a synthetic source-view apply type that could not
// support navigation (collapsed instance members; find-all-references crashed the
// server). The `.mix` method itself stays on every EMITTED value: it is the
// application path for external (non-transformer) consumers of the package's
// declarations — which is why a mixin imported from a `.d.ts` is exempt.
export function pushManualMixinApplicationDiagnostics(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    context: FileMixinContext
): void {
    // Cheap prefilter: the walk only runs for files that both know some mixin by name
    // and textually mention `.mix` at all.
    if (context.byLocalName.size === 0 || !sourceFile.text.includes(".mix")) {
        return
    }

    const visit = (node: ts.Node): void => {
        if (tsInstance.isPropertyAccessExpression(node) &&
            node.name.text === "mix" &&
            node.pos >= 0 && node.end >= 0
        ) {
            // Lexical resolution: a plain class shadowing a mixin name in a nearer scope
            // makes `X.mix` an ordinary (failing) property access, not a manual application.
            // A QUALIFIED base (`lib.Logger.mix`) resolves by its dotted text.
            const ref = tsInstance.isIdentifier(node.expression)
                ? resolveLexicalMixinRef(tsInstance, node.expression, node.expression.text, context)
                : dottedTextRef(tsInstance, node.expression, context)

            if (ref !== undefined && isProgramLocalMixinRef(ref, context)) {
                context.nativeDiagnostics.push(nativeDiagnosticOn(
                    tsInstance,
                    sourceFile,
                    node,
                    mixinDiagnosticCode.MixinManualApplication,
                    manualMixinApplicationMessage(ref)
                ))
            }
        }

        tsInstance.forEachChild(node, visit)
    }

    tsInstance.forEachChild(sourceFile, visit)
}

// The by-name ref of an all-identifier dotted expression (`lib.Logger`), for the ban scan.
function dottedTextRef(
    tsInstance: TypeScript,
    expression: ts.Expression,
    context: FileMixinContext
): ResolvedMixinRef | undefined {
    if (!tsInstance.isPropertyAccessExpression(expression)) {
        return undefined
    }

    const dotted = dottedExpressionText(tsInstance, expression)

    return dotted === undefined ? undefined : context.byLocalName.get(dotted)
}

// Program-local: declared in THIS file, or registered from another PROGRAM source
// file. A mixin resolved from a `.d.ts` (an external package consumed through its
// declarations) is not program-local — its `.mix` is the supported application path.
function isProgramLocalMixinRef(ref: ResolvedMixinRef, context: FileMixinContext): boolean {
    if (ref.declaration !== undefined) {
        return true
    }

    const registered = context.crossFile?.registry.get(ref.key)

    return registered !== undefined && !isDeclarationFileName(registered.fileName)
}

function manualMixinApplicationMessage(ref: ResolvedMixinRef): string {
    return "Manual mixin application inside a transformer program. " +
        `${ref.className}.mix(...) is reserved for external (non-transformer) consumers of this ` +
        "package's emitted declarations; in this program the transformer composes mixins from the " +
        `class heritage. Fix: declare 'class X extends YourBase implements ${ref.className}' ` +
        `(or just 'implements ${ref.className}' for a base-less class) instead of extending ` +
        `${ref.className}.mix(...).`
}
