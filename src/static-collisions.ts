import type * as ts from "typescript"
import {
    cloneExpressionWithTypeArguments,
    createDiagnosticLiteralType,
    heritageTypeText,
    heritageTypeToTypeReference,
    intersectionOrSingle,
    typeNodeReferencesTypeParameters
} from "./expand-util.js"
import { dottedNameToEntityName, expressionToEntityName } from "./entity-name.js"
import {
    type RequiredBaseValidation,
    type ResolvedMixinRef,
    type StaticCollisionCheckMode,
    type StaticSource
} from "./model.js"
import {
    generatedName,
    instanceConflictKeysLocalName,
    staticConflictKeysLocalName,
    uniqueTypeParameterName
} from "./naming.js"
import type { SourceFileFacts } from "./source-file-facts.js"
import { cloneNode } from "./util.js"
import {
    collapseSubtreeTextRange,
    generatedTextRange,
    preserveSubtreeTextRange,
    preserveTextRange
} from "./text-range.js"
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

// §7.27 — the source-view NAVIGABLE FAST PATH's instance-member collision check. The fast
// path types the consumer's base as an intersection, where two contributors' incompatible
// same-named instance members silently collapse to a `never`-typed member — the emit plane's
// (and the source-view slow path's) `$base` interface raises TS2320 instead. This emits ONE
// zero-runtime carrier per consumer:
//
//     type __C$memberCollision<Check extends never =
//         [ ConflictingInstanceKeys<Base & M1 & M2> ] extends [ never ] ? never : "<msg>"
//     > = Check
//
// The DEFAULT argument is constraint-checked eagerly at the declaration, so a conflict
// raises TS2344 carrying the literal message, pinned onto the offending heritage reference.
// LINEAR by design (2026-07 review insight): the whole combined intersection is inspected
// for `never`-collapsed keys at once — no pairwise sweep, and combination-only conflicts
// (`{1|2} & {2|3} & {1|3}`) that no pair exhibits are caught too. Gated on facts: emitted
// only when at least two SAME-FILE contributors' instance names overlap (ordinary consumers
// emit nothing; imported contributors still participate in the combined type, but cannot
// gate). A contributor whose heritage references the consumer's own type parameters is
// skipped — those are unbound outside the class body.
export function createInstanceCollisionStatements(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    mixinHeritageTypes: readonly ts.ExpressionWithTypeArguments[],
    facts: SourceFileFacts
): ts.Statement[] {
    const consumerName = declaration.name?.text

    if (consumerName === undefined) {
        return []
    }

    const ownTypeParameterNames = new Set(
        (declaration.typeParameters ?? []).map((typeParameter) => typeParameter.name.text)
    )
    const contributorTypes      = [
        ...(extendsType === undefined ? [] : [ extendsType ]),
        ...mixinHeritageTypes
    ].filter((heritageType) => !typeNodeReferencesTypeParameters(tsInstance, heritageType, ownTypeParameterNames))

    if (contributorTypes.length < 2) {
        return []
    }

    // The facts gate: names declared by at least TWO same-file contributors. Imported
    // contributors have no collected facts and cannot gate (mirrors the static check's
    // source-view behavior of skipping unknown sources).
    const knownContributors = contributorTypes.flatMap((heritageType) => {
        if (!tsInstance.isIdentifier(heritageType.expression)) {
            return []
        }

        const classFacts = facts.classesByName.get(heritageType.expression.text)

        return classFacts === undefined
            ? []
            : [ { heritageType, name: heritageType.expression.text, instanceNames: classFacts.instanceNames } ]
    })
    const seenNames        = new Set<string>()
    const overlappingNames = new Set<string>()
    let   pinContributor: ts.ExpressionWithTypeArguments | undefined

    for (const contributor of knownContributors) {
        for (const name of contributor.instanceNames) {
            if (seenNames.has(name)) {
                overlappingNames.add(name)
                pinContributor ??= contributor.heritageType
            }
        }

        contributor.instanceNames.forEach((name) => seenNames.add(name))
    }

    if (overlappingNames.size === 0 || pinContributor === undefined) {
        return []
    }

    const factory      = tsInstance.factory
    const combinedType = intersectionOrSingle(
        tsInstance,
        contributorTypes.map((heritageType) =>
            heritageTypeToTypeReference(tsInstance, cloneExpressionWithTypeArguments(tsInstance, heritageType)))
    )
    const conflictKeys = factory.createTypeReferenceNode(instanceConflictKeysLocalName, [ combinedType ])
    const defaultType  = factory.createConditionalTypeNode(
        factory.createTupleTypeNode([ conflictKeys ]),
        factory.createTupleTypeNode([ factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword) ]),
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
        factory.createLiteralTypeNode(factory.createStringLiteral(instanceCollisionDiagnosticMessage(
            consumerName,
            knownContributors.map((contributor) => contributor.name),
            [ ...overlappingNames ]
        )))
    )
    const alias        = factory.createTypeAliasDeclaration(
        undefined,
        generatedName(consumerName, "$memberCollision"),
        [ factory.createTypeParameterDeclaration(
            undefined,
            "Check",
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
            defaultType
        ) ],
        factory.createTypeReferenceNode("Check", undefined)
    )

    // No `setOriginalNode(alias, declaration)` here: a class-original type alias is exactly
    // how `appendGeneratedConfigAliasesAsRealText` DETECTS generated config aliases — this
    // carrier must stay a synthetic statement, not real appended text (which would lose the
    // diagnostic pin below to the reparse).
    const generatedRange = generatedTextRange(sourceFile, declaration.end)

    preserveTextRange(tsInstance, alias, generatedRange)
    collapseSubtreeTextRange(tsInstance, alias, generatedRange)
    // Re-pin the diagnostic carrier (the checked DEFAULT) onto the first heritage reference
    // that re-declares an already-seen member name, so the TS2344 lands on the user's
    // `implements …` entry instead of an artifact position.
    preserveSubtreeTextRange(tsInstance, defaultType, pinContributor)

    return [ alias ]
}

function instanceCollisionDiagnosticMessage(
    consumerName: string,
    contributorNames: string[],
    overlappingNames: string[]
): string {
    return "Instance mixin member collision. " +
        `Consumer ${consumerName} combines ${contributorNames.join(", ")}, which declare instance member(s) ` +
        `whose types do not merge: ${overlappingNames.join(", ")}. ` +
        "The combined member type collapses to 'never', so no value can satisfy every layer. " +
        "Fix: align the member types, or remove one mixin from the implements list."
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

