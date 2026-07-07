import type * as ts from "typescript"
import { constructionHeadType, type ConstructionBrand } from "./construction-brand.js"
import {
    cloneExpressionWithTypeArguments,
    createLinearizationPlanLiteral,
    dottedNameToEntityName,
    expressionToEntityName,
    heritageTypeToTypeReference,
    intersectionOrSingle,
    linearizationMode,
    mixinValueIdentifier
} from "./expand-util.js"
import {
    anyConstructorName,
    classStaticsName,
    mixinChainLocalName,
    mixinChainLinearizedLocalName,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import type { LinearizationPlanSlice } from "./linearization.js"
import { cloneNode, deepCloneNode } from "./util.js"
import { preserveSubtreeTextRange, preserveTextRange, zeroWidthRange } from "./text-range.js"
import type { TypeScript } from "./util.js"

// Statics a consumer inherits from an applied mixin: the mixin's own statics
// minus `prototype` and `new`. A construction-base mixin carries its own
// construction `new` (returning the mixin instance type), but a consumer
// generates its own `new` returning the consumer instance type. Inheriting the
// mixin's `new` as a property-typed member would force strict (contravariant)
// parameter checking and make the consumer's stricter `new` an incompatible
// static-side override (TS2417), so it is excluded here.
function createMixinStaticsType(
    tsInstance: TypeScript,
    valueName: string
): ts.TypeNode {
    return createStaticsBag(tsInstance, dottedNameToEntityName(tsInstance, valueName))
}

// The statics bag of every applied mixin whose runtime value is available in the
// file (`Omit<typeof X, "prototype" | "new">` each). Shared by all four base casts.
export function mixinStaticsTypes(
    tsInstance: TypeScript,
    mixinRefs: ResolvedMixinRef[]
): ts.TypeNode[] {
    return mixinRefs
        .filter((ref) => ref.localValueName !== undefined)
        .map((ref) => createMixinStaticsType(tsInstance, ref.localValueName as string))
}

function createMixinChainExpression(
    tsInstance: TypeScript,
    mixinRefs: ResolvedMixinRef[],
    baseExpression: ts.Expression,
    linearizationPlan: LinearizationPlanSlice[] | undefined,
    mode: "verify" | "replay" | "c3"
): ts.Expression {
    const factory = tsInstance.factory

    // Approach (B): when the compiler precomputed the consumer's chain order, apply the
    // mixins through `mixinChainLinearized(base, [m1, m2], plan, mode)` (the mixins ride in an
    // array, the plan and mode trail) so the runtime replays the plan instead of running C3.
    // With no plan (a conflict -- reported elsewhere) keep the variadic `mixinChain`.
    if (linearizationPlan !== undefined) {
        return factory.createCallExpression(
            factory.createIdentifier(mixinChainLinearizedLocalName),
            undefined,
            [
                baseExpression,
                factory.createArrayLiteralExpression(mixinRefs.map((ref) => mixinValueIdentifier(tsInstance, ref))),
                createLinearizationPlanLiteral(tsInstance, linearizationPlan),
                factory.createStringLiteral(mode)
            ]
        )
    }

    return factory.createCallExpression(
        factory.createIdentifier(mixinChainLocalName),
        undefined,
        [
            baseExpression,
            ...mixinRefs.map((ref) => mixinValueIdentifier(tsInstance, ref))
        ]
    )
}

export function unsupportedBaseConsumerHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    directMixinRefs: ResolvedMixinRef[],
    linearizedMixinRefs: ResolvedMixinRef[],
    options: TransformOptions
): ts.HeritageClause {
    const factory = tsInstance.factory

    if (options.sourceView) {
        return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            cloneExpressionWithTypeArguments(tsInstance, extendsType)
        ])
    }

    return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
            factory.createParenthesizedExpression(
                factory.createAsExpression(
                    factory.createAsExpression(
                        createMixinChainExpression(
                            tsInstance,
                            directMixinRefs,
                            cloneNode(tsInstance, extendsType.expression),
                            undefined,
                            linearizationMode(options)
                        ),
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    ),
                    createUnsupportedBaseConsumerCastType(tsInstance, linearizedMixinRefs)
                )
            ),
            undefined
        )
    ])
}

export function consumerBaseClassHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    directMixinRefs: ResolvedMixinRef[],
    linearizedMixinRefs: ResolvedMixinRef[],
    options: TransformOptions,
    // Set when the consumer transitively extends the package `Base` (a construction
    // base): the cast's construct signature is branded (so a direct `new Consumer(...)`
    // is a type error) or permissive (for a manual-constructor consumer). See
    // constructionHeadType / ConstructionBrand.
    construction?: ConstructionBrand,
    // Approach (B): the precomputed chain order for the runtime `mixinChainLinearized`
    // call. Emit only -- source view emits no runtime chain.
    linearizationPlan?: LinearizationPlanSlice[]
): ts.HeritageClause {
    const factory = tsInstance.factory

    // DEEP clone the base expression: `factory.cloneNode` is shallow and SHARES a
    // qualified base's children (`ns`, `Base`) with the parse tree — the generated
    // `$base` class this heritage lands in is then subtree-collapsed, which would
    // stamp the SHARED user nodes to the collapsed range and destroy the source
    // positions the real heritage (and the navigable fast path) navigates by.
    if (options.sourceView) {
        return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            factory.createExpressionWithTypeArguments(
                factory.createParenthesizedExpression(
                    factory.createAsExpression(
                        factory.createAsExpression(
                            deepCloneNode(
                                tsInstance,
                                consumerRuntimeBaseType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName)
                                    .expression
                            ),
                            factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                        ),
                        createSourceViewConsumerBaseCastType(
                            tsInstance,
                            extendsType,
                            implicitRequiredBase,
                            emptyBaseName,
                            linearizedMixinRefs,
                            construction
                        )
                    )
                ),
                undefined
            )
        ])
    }

    return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(
            factory.createParenthesizedExpression(
                factory.createAsExpression(
                    factory.createAsExpression(
                        createMixinChainExpression(
                            tsInstance,
                            directMixinRefs,
                            deepCloneNode(
                                tsInstance,
                                consumerRuntimeBaseType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName)
                                    .expression
                            ),
                            linearizationPlan,
                            linearizationMode(options)
                        ),
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    ),
                    createConsumerBaseCastType(
                        tsInstance,
                        extendsType,
                        implicitRequiredBase,
                        emptyBaseName,
                        linearizedMixinRefs,
                        construction
                    )
                )
            ),
            undefined
        )
    ])
}

// `Omit<typeof <entity>, "prototype" | "new" | "mix">`: an entity's static side as a plain
// property bag, with no construct signature (see createNavigableConsumerBaseCastType).
// `mix` is excluded like `new`: it is installed on mixin VALUES only (`defineMixinClass`),
// never inherited by consumers at runtime, so carrying it in the consumer's static type is a
// type lie — and it blocks a consumer's own `static mix` with a TS2417 override conflict
// (same failure mode the `new` exclusion prevents; a mixin's own dependency statics already
// exclude `mix` — see the metadata-base `Omit` in mixin-expand).
export function createStaticsBag(tsInstance: TypeScript, entityName: ts.EntityName): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createTypeReferenceNode("Omit", [
        factory.createTypeQueryNode(entityName),
        factory.createUnionTypeNode([
            factory.createLiteralTypeNode(factory.createStringLiteral("prototype")),
            factory.createLiteralTypeNode(factory.createStringLiteral("new")),
            factory.createLiteralTypeNode(factory.createStringLiteral("mix"))
        ])
    ])
}

export function consumerRuntimeBaseType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined
): ts.ExpressionWithTypeArguments {
    if (extendsType !== undefined) {
        return extendsType
    }

    if (implicitRequiredBase !== undefined) {
        return implicitRequiredBase
    }

    if (emptyBaseName === undefined) {
        return tsInstance.factory.createExpressionWithTypeArguments(
            tsInstance.factory.createIdentifier("Object"),
            undefined
        )
    }

    return tsInstance.factory.createExpressionWithTypeArguments(
        tsInstance.factory.createIdentifier(emptyBaseName as string),
        undefined
    )
}

// Runtime-chain cast: typeof Base (or typeof __X without an explicit base)
// plus statics for each applied mixin whose value is available in the file.
function createConsumerBaseCastType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    mixinRefs: ResolvedMixinRef[],
    construction?: ConstructionBrand
): ts.TypeNode {
    const types = [
        createConsumerBaseHeadType(tsInstance, extendsType, implicitRequiredBase, emptyBaseName, construction),
        ...mixinStaticsTypes(tsInstance, mixinRefs)
    ]

    return intersectionOrSingle(tsInstance, types)
}

function createSourceViewConsumerBaseCastType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    mixinRefs: ResolvedMixinRef[],
    construction?: ConstructionBrand
): ts.TypeNode {
    const types = [
        createSourceViewConsumerBaseHeadType(
            tsInstance,
            extendsType,
            implicitRequiredBase,
            emptyBaseName,
            construction
        ),
        ...mixinStaticsTypes(tsInstance, mixinRefs)
    ]

    return intersectionOrSingle(tsInstance, types)
}

function createUnsupportedBaseConsumerCastType(
    tsInstance: TypeScript,
    mixinRefs: ResolvedMixinRef[]
): ts.TypeNode {
    const types = [
        tsInstance.factory.createTypeReferenceNode(anyConstructorName, undefined),
        ...mixinStaticsTypes(tsInstance, mixinRefs)
    ]

    return intersectionOrSingle(tsInstance, types)
}

// The source-view twin of `createConsumerBaseHeadType` below: the `$base` interface always
// re-extends the base in source view, so the construction head's construct returns a plain
// `object` instead of naming the base. Exported for the mixin's own source-view heritage
// (`mixin-source-view.ts`), which reuses the consumer head for its `$base` cast.
export function createSourceViewConsumerBaseHeadType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    construction?: ConstructionBrand
): ts.TypeNode {
    const factory  = tsInstance.factory
    const baseType = extendsType ?? implicitRequiredBase

    if (baseType === undefined) {
        return factory.createTypeQueryNode(factory.createIdentifier(emptyBaseName as string))
    }

    if (construction !== undefined) {
        // Source view: the `$base` interface always re-extends the base (even without
        // type arguments), so it carries the base instance and the construct returns a
        // plain `object` — naming the base here would either double-extend it (TS2320)
        // or, for a generic base, reference the consumer's type parameter in a base
        // expression (TS2562).
        return constructionHeadType(
            tsInstance,
            expressionToEntityName(tsInstance, baseType.expression),
            construction,
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.ObjectKeyword)
        )
    }

    if (baseType.typeArguments === undefined) {
        return factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
    }

    return factory.createIntersectionTypeNode([
        factory.createTypeReferenceNode(anyConstructorName, undefined),
        factory.createTypeReferenceNode(classStaticsName, [
            factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
        ])
    ])
}

function createConsumerBaseHeadType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    emptyBaseName: string | undefined,
    construction?: ConstructionBrand
): ts.TypeNode {
    const factory  = tsInstance.factory
    const baseType = extendsType ?? implicitRequiredBase

    if (baseType === undefined) {
        return factory.createTypeQueryNode(factory.createIdentifier(emptyBaseName as string))
    }

    if (construction !== undefined) {
        // Emit path: the `$base` interface re-extends the base only when it has type
        // arguments. Without them the consumer's base instance members flow solely
        // through this construct return, so it must name the base (a plain `object`
        // would drop `initialize` and the base's own fields). With type arguments the
        // interface already carries (and would double-extend, TS2320) the generic base,
        // and naming `Base<T>` here would reference the consumer type parameter in a base
        // expression (TS2562), so a plain `object` is used instead.
        return constructionHeadType(
            tsInstance,
            expressionToEntityName(tsInstance, baseType.expression),
            construction,
            baseType.typeArguments === undefined
                ? heritageTypeToTypeReference(tsInstance, baseType)
                : factory.createKeywordTypeNode(tsInstance.SyntaxKind.ObjectKeyword)
        )
    }

    if (baseType.typeArguments === undefined) {
        return factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
    }

    return factory.createIntersectionTypeNode([
        factory.createTypeReferenceNode(anyConstructorName, undefined),
        factory.createTypeReferenceNode(classStaticsName, [
            factory.createTypeQueryNode(expressionToEntityName(tsInstance, baseType.expression))
        ])
    ])
}

// The consumer's REPLACED heritage: `extends <baseName><typeArguments>` (the generated
// `$base`), keeping the source `implements` clause (and its positions) when requested.
// Shared by the consumer expansion and the mixin's own source-view heritage. The pinning
// below maps the generated clause onto the source heritage ranges so source view stays
// navigable; on emit the ranges are throwaway synthetic ones.
export function consumerHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    baseName: string,
    generatedRange: ts.TextRange,
    generatedTypeRange: ts.TextRange = generatedRange,
    extraTypeArguments: ts.TypeNode[] = [],
    keepImplements = true
): ts.NodeArray<ts.HeritageClause> {
    const factory = tsInstance.factory

    const ownTypeArguments = declaration.typeParameters !== undefined && declaration.typeParameters.length > 0
        ? declaration.typeParameters.map((typeParameter): ts.TypeNode => {
            return factory.createTypeReferenceNode(typeParameter.name.text, undefined)
        })
        : []
    const typeArguments    = ownTypeArguments.length > 0 || extraTypeArguments.length > 0
        ? [ ...ownTypeArguments, ...extraTypeArguments ]
        : undefined

    const extendsType = preserveTextRange(
        tsInstance,
        factory.createExpressionWithTypeArguments(
            factory.createIdentifier(baseName),
            typeArguments
        ),
        generatedTypeRange
    )

    if (tsInstance.isExpressionWithTypeArguments(generatedTypeRange as ts.Node)) {
        const originalGeneratedTypeRange = generatedTypeRange as ts.ExpressionWithTypeArguments

        preserveTextRange(tsInstance, extendsType.expression, originalGeneratedTypeRange.expression)

        if (extendsType.typeArguments !== undefined) {
            const generatedTypeArgumentRange = zeroWidthRange(originalGeneratedTypeRange.expression.end)

            preserveTextRange(
                tsInstance,
                extendsType.typeArguments,
                originalGeneratedTypeRange.typeArguments ?? generatedTypeArgumentRange
            )

            const sourceTypeArguments    = originalGeneratedTypeRange.typeArguments
            const lastSourceTypeArgument = sourceTypeArguments?.[sourceTypeArguments.length - 1]

            extendsType.typeArguments.forEach((typeArgument, index) => {
                const originalTypeArgument = sourceTypeArguments?.[index]

                if (originalTypeArgument !== undefined) {
                    preserveSubtreeTextRange(tsInstance, typeArgument, originalTypeArgument)
                } else if (index < ownTypeArguments.length && lastSourceTypeArgument !== undefined) {
                    // The consumer's own type params re-referenced past the source
                    // heritage's type-argument count (the `A` in `__C$base<T, A>`
                    // positioned over `SourceClass1<T>`) have no source counterpart.
                    // Left unranged they inherit a wide ancestor range that strands
                    // the source type identifiers in a SyntaxList trivia gap
                    // (invariant #5). Overlap the last source argument: width >= 1
                    // (not "missing"/`any`, invariant #2) and ending at the list end
                    // so no trailing gap is scanned. Validation type arguments
                    // (index >= ownTypeArguments.length) keep their own diagnostic
                    // ranges and must not be touched here.
                    preserveSubtreeTextRange(tsInstance, typeArgument, lastSourceTypeArgument)
                }
            })
        }
    }

    const extendsHeritage = preserveTextRange(
        tsInstance,
        factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            extendsType
        ]),
        generatedRange
    )

    preserveTextRange(tsInstance, extendsHeritage.types, generatedTypeRange)

    const implementsHeritage = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })
    const clauses            = keepImplements && implementsHeritage !== undefined
        ? [ extendsHeritage, implementsHeritage ]
        : [ extendsHeritage ]
    const heritageRange      = keepImplements ? declaration.heritageClauses ?? generatedRange : generatedRange

    return preserveTextRange(tsInstance, factory.createNodeArray(clauses), heritageRange)
}

export { isSupportedBaseExpression } from "./model.js"
