import type * as ts from "typescript"
import {
    anyConstructorName,
    isDeclarationFileName,
    mixinApplicationName,
    mixinDiagnosticCode,
    requiredBaseType,
    type FileMixinContext,
    type ResolvedMixinRef
} from "./model.js"
import { heritageTypeToTypeReference } from "./expand-util.js"
import { resolveLexicalMixinRef } from "./mixin-refs.js"
import { deepCloneNode, stripVarianceAnnotations } from "./util.js"
import type { TypeScript } from "./util.js"

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
            tsInstance.isIdentifier(node.expression) &&
            node.pos >= 0 && node.end >= 0
        ) {
            // Lexical resolution: a plain class shadowing a mixin name in a nearer scope
            // makes `X.mix` an ordinary (failing) property access, not a manual application.
            const ref = resolveLexicalMixinRef(tsInstance, node.expression, node.expression.text, context)

            if (ref !== undefined && isProgramLocalMixinRef(ref, context)) {
                const start = node.getStart(sourceFile)

                context.nativeDiagnostics.push({
                    fileName    : sourceFile.fileName,
                    start,
                    length      : node.getEnd() - start,
                    code        : mixinDiagnosticCode.MixinManualApplication,
                    category    : tsInstance.DiagnosticCategory.Error,
                    messageText : manualMixinApplicationMessage(ref)
                })
            }
        }

        tsInstance.forEachChild(node, visit)
    }

    tsInstance.forEachChild(sourceFile, visit)
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
