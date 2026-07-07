import type * as ts from "typescript"
import { createDiagnosticLiteralType, heritageTypeText } from "./expand-util.js"
import { dottedNameToEntityName, expressionToEntityName } from "./entity-name.js"
import {
    type RequiredBaseValidation,
    type ResolvedMixinRef,
    type StaticCollisionCheckMode,
    type StaticSource
} from "./model.js"
import { staticConflictKeysLocalName, uniqueTypeParameterName } from "./naming.js"
import type { SourceFileFacts } from "./source-file-facts.js"
import { cloneNode } from "./util.js"
import { preserveTextRange } from "./text-range.js"
import type { TypeScript } from "./util.js"

export function createStaticCollisionValidations(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    mixinRefs: ResolvedMixinRef[],
    generatedRange: ts.TextRange,
    facts: SourceFileFacts,
    mode: StaticCollisionCheckMode,
    sourceView = false
): RequiredBaseValidation[] {
    if (mode === false) {
        return []
    }

    const allSources                            = [
        ...consumerBaseStaticSources(tsInstance, sourceFile, extendsType, implicitRequiredBase, emptyBaseName, facts),
        ...mixinRefs.flatMap((ref) => {
            return mixinStaticSource(tsInstance, ref, facts)
        })
    ]
    const sources                               = sourceView
        ? allSources.filter((source) => {
            return source.staticNames !== undefined && source.staticNames.size > 0
        })
        : allSources
    const validations: RequiredBaseValidation[] = []

    for (let leftIndex = 0; leftIndex < sources.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < sources.length; rightIndex++) {
            const left         = sources[leftIndex]
            const right        = sources[rightIndex]
            const knownOverlap = knownStaticNameOverlap(left, right)

            if (sourceView && knownOverlap === undefined) {
                continue
            }

            if (knownOverlap !== undefined && knownOverlap.length === 0) {
                continue
            }

            validations.push({
                typeParameter : preserveTextRange(
                    tsInstance,
                    tsInstance.factory.createTypeParameterDeclaration(
                        undefined,
                        uniqueTypeParameterName(declaration, `__mixinStaticCollision${validations.length}`),
                        tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
                        undefined
                    ),
                    generatedRange
                ),
                typeArgument : preserveTextRange(
                    tsInstance,
                    sourceView && knownOverlap !== undefined
                        ? createDiagnosticLiteralType(tsInstance, staticCollisionDiagnosticMessage(
                            declaration,
                            left,
                            right,
                            knownOverlap
                        ))
                        : createStaticCollisionDiagnosticType(
                            tsInstance,
                            declaration,
                            left,
                            right,
                            knownOverlap,
                            mode
                        ),
                    generatedRange
                )
            })
        }
    }

    return validations
}

function consumerBaseStaticSources(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    facts: SourceFileFacts
): StaticSource[] {
    const baseType = extendsType ?? implicitRequiredBase

    if (baseType === undefined) {
        if (emptyBaseName === undefined) {
            return []
        }

        return [ {
            name        : emptyBaseName,
            typeNode    : tsInstance.factory.createTypeQueryNode(tsInstance.factory.createIdentifier(emptyBaseName)),
            staticNames : new Set()
        } ]
    }

    return [ {
        name        : heritageTypeText(tsInstance, sourceFile, baseType),
        typeNode    : tsInstance.factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression)),
        staticNames : staticNamesOfBaseExpression(tsInstance, baseType.expression, facts)
    } ]
}

function mixinStaticSource(
    tsInstance: TypeScript,
    ref: ResolvedMixinRef,
    facts: SourceFileFacts
): StaticSource[] {
    if (ref.localValueName === undefined) {
        return []
    }

    return [ {
        name        : ref.className,
        typeNode    : tsInstance.factory.createTypeQueryNode(dottedNameToEntityName(tsInstance, ref.localValueName)),
        staticNames : ref.declaration === undefined
            ? undefined
            : facts.classesByDeclaration.get(ref.declaration)?.staticNames
    } ]
}

function staticNamesOfBaseExpression(
    tsInstance: TypeScript,
    expression: ts.Expression,
    facts: SourceFileFacts
): Set<string> | undefined {
    if (!tsInstance.isIdentifier(expression)) {
        return undefined
    }

    return facts.classesByName.get(expression.text)?.staticNames
}

function knownStaticNameOverlap(
    left: StaticSource,
    right: StaticSource
): string[] | undefined {
    if (left.staticNames === undefined || right.staticNames === undefined) {
        return undefined
    }

    return [ ...left.staticNames ].filter((name) => right.staticNames?.has(name) === true)
}

function createStaticCollisionDiagnosticType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    left: StaticSource,
    right: StaticSource,
    knownOverlap: string[] | undefined,
    mode: Exclude<StaticCollisionCheckMode, false>
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createConditionalTypeNode(
        factory.createTupleTypeNode([
            factory.createTypeReferenceNode(staticConflictKeysLocalName(mode), [
                cloneNode(tsInstance, left.typeNode),
                cloneNode(tsInstance, right.typeNode)
            ])
        ]),
        factory.createTupleTypeNode([
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
        ]),
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
        factory.createLiteralTypeNode(factory.createStringLiteral(
            staticCollisionDiagnosticMessage(declaration, left, right, knownOverlap)
        ))
    )
}

function staticCollisionDiagnosticMessage(
    declaration: ts.ClassDeclaration,
    left: StaticSource,
    right: StaticSource,
    knownOverlap: string[] | undefined
): string {
    const consumerName = declaration.name?.text ?? "<anonymous consumer>"
    const names        = knownOverlap === undefined || knownOverlap.length === 0
        ? "one or more static members"
        : knownOverlap.join(", ")

    return "Static mixin member collision. " +
        `Consumer ${consumerName} combines ${left.name} and ${right.name}, which both declare incompatible static member(s): ${names}. ` +
        "Runtime inheritance can only keep one implementation for a static name, so this would make the generated class misleadingly typed. " +
        "Fix: rename one static member, make the static member types compatible, or remove one mixin from the implements list."
}

