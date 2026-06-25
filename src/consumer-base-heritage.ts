import type * as ts from "typescript"
import {
    constructionHeadType,
    cloneExpressionWithTypeArguments,
    createLinearizationPlanLiteral,
    createSourceViewConsumerBaseHeadType,
    expressionToEntityName,
    heritageTypeToTypeReference,
    intersectionOrSingle,
    linearizationMode,
    mixinValueIdentifier,
    type ConstructionBrand
} from "./expand-util.js"
import {
    anyConstructorName,
    classStaticsName,
    mixinChainName,
    mixinChainLinearizedName,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import type { LinearizationPlanSlice } from "./linearization.js"
import {
    cloneNode,
    preserveTextRange
} from "./util.js"
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
    return createStaticsBag(tsInstance, tsInstance.factory.createIdentifier(valueName))
}

// The statics bag of every applied mixin whose runtime value is available in the
// file (`Omit<typeof X, "prototype" | "new">` each). Shared by all four base casts.
function mixinStaticsTypes(
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
            factory.createIdentifier(mixinChainLinearizedName),
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
        factory.createIdentifier(mixinChainName),
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

    if (options.sourceView) {
        return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            factory.createExpressionWithTypeArguments(
                factory.createParenthesizedExpression(
                    factory.createAsExpression(
                        factory.createAsExpression(
                            cloneNode(
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
                            cloneNode(
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

// Source-view "navigable base" fast path. When a NON-GENERIC consumer has an
// explicit `extends Base` and produces no diagnostic validations (i.e. well-typed
// code), we skip the generated `$base` indirection entirely: the consumer's own
// heritage becomes `extends (Base as unknown as <cast>)` with the REAL base
// expression pinned onto the source base position, so go-to-definition /
// find-all-references / quickinfo on the base name reach the real base class
// instead of the internal `$base`. The cast (see createNavigableConsumerBaseCastType)
// carries the base + every mixin instance and the statics, so `super.<mixinMember>`,
// statics and own members all keep resolving.
//
// Position handling: the real base identifier is pinned onto the source base name
// (`extends Base` → the `Base` token) so navigation lands there. The synthetic
// `as unknown as <cast>` type machinery covers the remainder of the source
// heritage-type span (the `<...>` type arguments and trailing trivia) so no source
// text is stranded in a SyntaxList gap (invariant #5) while no synthetic node
// overlaps the base name itself.
export function navigableConsumerBaseClassHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinHeritage: ts.ExpressionWithTypeArguments[],
    linearizedMixinRefs: ResolvedMixinRef[],
    generatedHeritageTypeRange: ts.ExpressionWithTypeArguments
): ts.HeritageClause {
    const factory = tsInstance.factory

    const baseExpression = cloneNode(tsInstance, extendsType.expression)
    const castType       = createNavigableConsumerBaseCastType(
        tsInstance,
        extendsType,
        mixinHeritage,
        linearizedMixinRefs
    )
    const innerAs        = factory.createAsExpression(
        baseExpression,
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
    )
    const outerAs        = factory.createAsExpression(innerAs, castType)
    const extendsExpr    = factory.createExpressionWithTypeArguments(outerAs, undefined)

    // The source heritage type spans `Base<...>`. The navigable real base identifier
    // is stretched over that whole span so the base name resolves AND no source
    // character is stranded in a SyntaxList gap (invariant #5); its ancestors share
    // the same range. The base is a simple identifier here (the fast path is gated to
    // identifier bases — a qualified `ns.Base` keeps `$base`, since a shallow clone
    // leaves its inner `Base` at `[-1, -1]` and navigation cannot land on it). The
    // `as unknown as <cast>` machinery is left SYNTHETIC (negative positions):
    // collapsing it onto source text would make the checker re-read the synthetic
    // `Omit<…, "prototype" | "new">` string literals from the source, blanking them
    // into `Omit<…, >` so the cast degrades to `any` and the base loses its members
    // (TS4112/TS2339). Synthetic type nodes keep their own factory text and claim no
    // source range, so they neither corrupt nor strand.
    const fullRange = generatedHeritageTypeRange

    preserveTextRange(tsInstance, baseExpression, fullRange)
    preserveTextRange(tsInstance, innerAs, fullRange)
    preserveTextRange(tsInstance, outerAs, fullRange)
    preserveTextRange(tsInstance, extendsExpr, fullRange)

    const heritageClause = factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [ extendsExpr ])

    preserveTextRange(tsInstance, heritageClause.types, fullRange)

    return preserveTextRange(tsInstance, heritageClause, fullRange)
}

// Heritage for a mixin-LESS construction base class (`class Model extends Base`,
// `expandConstructionBaseClass`). These keep a literal `extends` in stock output, but
// to make `new Model(...)` a type error we re-extend the base under a single-source
// branded cast (`extends (Base as unknown as <branded construct + base statics>)`).
// Emit erases the `as` so the runtime stays `extends Base`; the cast only poisons the
// construct signature seen by the checker and downstream `.d.ts`.
//
// In source view the real base identifier is pinned over the source `extends Base`
// span (navigation + invariant #5) exactly like the navigable consumer fast path, so
// it is gated to a simple identifier base by the caller. In emit, positions do not
// matter, so the whole cast is left synthetic.
export function brandedConstructionBaseHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    consumerName: string,
    options: TransformOptions
): ts.HeritageClause {
    const factory = tsInstance.factory

    const baseExpression = cloneNode(tsInstance, extendsType.expression)
    const castType       = constructionHeadType(
        tsInstance,
        expressionToEntityName(tsInstance, extendsType.expression),
        { consumerName, branded: true },
        heritageTypeToTypeReference(tsInstance, extendsType)
    )
    const innerAs        = factory.createAsExpression(
        baseExpression,
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
    )
    const outerAs        = factory.createAsExpression(innerAs, castType)
    const extendsExpr    = factory.createExpressionWithTypeArguments(outerAs, undefined)

    if (!options.sourceView) {
        return factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [ extendsExpr ])
    }

    const fullRange = extendsType

    preserveTextRange(tsInstance, baseExpression, fullRange)
    preserveTextRange(tsInstance, innerAs, fullRange)
    preserveTextRange(tsInstance, outerAs, fullRange)
    preserveTextRange(tsInstance, extendsExpr, fullRange)

    const heritageClause = factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [ extendsExpr ])

    preserveTextRange(tsInstance, heritageClause.types, fullRange)

    return preserveTextRange(tsInstance, heritageClause, fullRange)
}

// The cast for the navigable fast path is "single source": unlike the `$base`
// split (a generated interface for instance members + a class for statics), here
// the consumer extends this cast directly, so the cast's constructor instance type
// must carry the base AND every applied mixin's instance members — that is what a
// `super.<mixinMember>` access resolves against. Statics are deliberately
// `Omit<typeof X, "prototype" | "new">` property bags carrying NO construct
// signature — a second construct signature (e.g. a bare `typeof Base`) would
// compete with the instance constructor and strand the mixin members, breaking
// `super.<mixinMember>`, `implements` and `override` (TS2720/TS4112). Only safe for
// a non-generic consumer: referencing the base/mixin instance types here cannot
// mention the consumer's own type parameters, so it never trips TS2562.
function createNavigableConsumerBaseCastType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinHeritage: ts.ExpressionWithTypeArguments[],
    linearizedMixinRefs: ResolvedMixinRef[]
): ts.TypeNode {
    const factory = tsInstance.factory

    const instanceTypes       = [
        heritageTypeToTypeReference(tsInstance, extendsType),
        ...mixinHeritage.map((heritageType) => heritageTypeToTypeReference(tsInstance, heritageType))
    ]
    const instanceConstructor = factory.createTypeReferenceNode(anyConstructorName, [
        instanceTypes.length === 1 ? instanceTypes[0] : factory.createIntersectionTypeNode(instanceTypes)
    ])
    const staticsTypes        = [
        createStaticsBag(tsInstance, expressionToEntityName(tsInstance, extendsType.expression)),
        ...mixinStaticsTypes(tsInstance, linearizedMixinRefs)
    ]

    return factory.createIntersectionTypeNode([ instanceConstructor, ...staticsTypes ])
}

// `Omit<typeof <entity>, "prototype" | "new">`: an entity's static side as a plain
// property bag, with no construct signature (see createNavigableConsumerBaseCastType).
function createStaticsBag(tsInstance: TypeScript, entityName: ts.EntityName): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createTypeReferenceNode("Omit", [
        factory.createTypeQueryNode(entityName),
        factory.createUnionTypeNode([
            factory.createLiteralTypeNode(factory.createStringLiteral("prototype")),
            factory.createLiteralTypeNode(factory.createStringLiteral("new"))
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
            tsInstance, extendsType, implicitRequiredBase, emptyBaseName, construction
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

export { isSupportedBaseExpression } from "./model.js"
