import type * as ts from "typescript"
import {
    cloneExpressionWithTypeArguments,
    constructionHeadType,
    createLinearizationPlanLiteral,
    createSourceViewConsumerBaseHeadType,
    dottedNameToEntityName,
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
    mixinChainLocalName,
    mixinChainLinearizedLocalName,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import type { LinearizationPlanSlice } from "./linearization.js"
import {
    cloneNode,
    collapseSubtreeTextRange,
    deepCloneNode,
    preserveSubtreeTextRange,
    preserveTextRange,
    stripVarianceAnnotations,
    zeroWidthRange
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
    return createStaticsBag(tsInstance, dottedNameToEntityName(tsInstance, valueName))
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

// Source-view "navigable base" fast path. When a consumer has an explicit
// `extends Base` (or `extends ns.Base`) and produces no diagnostic validations
// (i.e. well-typed code), we skip the generated `$base` indirection entirely: the
// consumer's own heritage becomes `extends (Base as unknown as <cast>)` with the
// REAL base expression pinned onto the source base position, so go-to-definition /
// find-all-references / quickinfo on the base name reach the real base class
// instead of the internal `$base`. The cast (see createNavigableConsumerBaseCastType)
// carries the base + every mixin instance and the statics, so `super.<mixinMember>`,
// statics and own members all keep resolving.
//
// A GENERIC consumer threads its type parameters through the cast's construct
// signature (declared on the signature — never in the base expression scope, which
// TS2562 forbids) and passes them back as heritage TYPE ARGUMENTS:
// `extends (Base as unknown as (new <T>(...) => Base & Mixin<T>) & statics)<T>`.
// A CONSTRUCTION consumer's cast head carries the direct-`new` brand (or the
// permissive construct for a manual-constructor consumer) inside that same
// signature — the mirror of the emitted `$base_base` type.
//
// Position handling: the real base identifier is pinned onto the source base name
// (`extends Base` → the `Base` token; for a qualified `ns.Base` every step of the
// chain is pinned onto its own source token) so navigation lands there. The
// synthetic `as unknown as <cast>` type machinery covers the remainder of the
// source heritage-type span (the `<...>` type arguments and trailing trivia) so no
// source text is stranded in a SyntaxList gap (invariant #5) while no synthetic
// node overlaps the base name itself.
// `extraStaticsTypes` extends the cast's statics intersection — a `@mixin` class rides
// its `RuntimeMixinClass<...>` metadata through here (the mixin's own heritage takes
// this same fast path; the extra members are fully synthetic and join the uniform
// cast stamp).
export function navigableConsumerBaseClassHeritage(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinHeritage: ts.ExpressionWithTypeArguments[],
    linearizedMixinRefs: ResolvedMixinRef[],
    generatedHeritageTypeRange: ts.ExpressionWithTypeArguments,
    typeParameters: readonly ts.TypeParameterDeclaration[] | undefined,
    construction: ConstructionBrand | undefined,
    extraStaticsTypes: ts.TypeNode[] = []
): ts.HeritageClause {
    const factory = tsInstance.factory

    const fullRange      = generatedHeritageTypeRange
    const baseExpression = pinnedQualifierExpression(tsInstance, extendsType.expression)
    // The transform runs over a layered clone whose nodes carry `.original` links to
    // the parse tree — ranges resolve through them (sourceRangeOf); the arguments
    // themselves are ALWAYS threaded (the signature's carrier arity must match even
    // when no positions are recoverable in a transient edit state).
    const sourceArguments = [ ...(extendsType.typeArguments ?? []) ]
    const firstArgument   = sourceArguments.length > 0 ? sourceRangeOf(sourceArguments[0]) : undefined
    const lastArgument    = sourceArguments.length > 0 ? sourceRangeOf(sourceArguments[sourceArguments.length - 1]) : undefined
    const argsRegion      = firstArgument !== undefined && lastArgument !== undefined &&
        firstArgument.pos >= 0 && lastArgument.end >= 0
        ? { pos: firstArgument.pos, end: lastArgument.end }
        : undefined
    const cast            = createNavigableConsumerBaseCastType(
        tsInstance,
        extendsType,
        mixinHeritage,
        linearizedMixinRefs,
        typeParameters,
        construction,
        extraStaticsTypes
    )
    const castType        = cast.type
    const innerAs         = factory.createAsExpression(
        baseExpression,
        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
    )
    const outerAs         = factory.createAsExpression(innerAs, castType)

    // Heritage type arguments instantiate the cast's generic construct signature: the
    // consumer's own type parameters first (a generic consumer threads them through the
    // signature — TS2562 bans them only in the base expression), then one PINNED CLONE
    // of each source base type argument, feeding the signature's inert carrier
    // parameters. The clones re-pin onto their originals 1:1 (the implements-clause
    // convention), and because heritage type arguments live in CLASS scope, quickinfo /
    // navigation / rename on a `T` inside `extends Base<T>` resolve exactly like the
    // user wrote them — the cast itself stays position-invisible.
    // WIDTH-1 anchors, never zero width: a zero-width real range makes the checker
    // treat the reference as MISSING and silently resolve it to `any`, which then
    // instantiates every base/mixin member type to `any`. The anchor is the FIRST
    // character of the base expression: position lookups there descend into the base
    // expression (an earlier sibling covering the same span), and no anchor END sits
    // on a token boundary a hover could prefer — so navigation never lands on these.
    const referenceAnchor         = { pos: Math.max(fullRange.pos, fullRange.end - 1), end: fullRange.end }
    const consumerParamReferences = (typeParameters ?? []).map((typeParameter) => {
        const reference = factory.createTypeReferenceNode(cloneNode(tsInstance, typeParameter.name), undefined)

        preserveTextRange(tsInstance, reference, referenceAnchor)
        preserveTextRange(tsInstance, reference.typeName, referenceAnchor)

        return reference as ts.TypeNode
    })
    const pinnedSourceArguments = sourceArguments.map((typeArgument) => {
        const clone  = deepCloneNode(tsInstance, typeArgument)
        const origin = sourceRangeOf(typeArgument)

        preserveSubtreeTextRange(
            tsInstance,
            clone,
            origin.pos >= 0 && origin.end >= 0 ? origin : referenceAnchor
        )

        return clone as ts.TypeNode
    })
    // Argument order mirrors the signature (carriers FIRST, consumer parameters
    // after) so the pinned clones lead the array POSITIONALLY as well — they absorb
    // the argument region in the SyntaxList scan, the end-anchored references trail.
    const typeArguments = consumerParamReferences.length + pinnedSourceArguments.length === 0
        ? undefined
        : [ ...pinnedSourceArguments, ...consumerParamReferences ]
    const extendsExpr   = factory.createExpressionWithTypeArguments(outerAs, typeArguments)

    // Position layout — three forces, satisfied together:
    //   - the CHECKER: no zero-width real range anywhere in the cast (`nodeIsMissing`
    //     treats such a node as missing and drops it — the construct signature would
    //     vanish and the consumer lose every base/mixin member), so the WHOLE cast is
    //     stamped uniformly over the heritage span;
    //   - the TRIVIA scan (tsserver getChildren): no positive GAP between a node's
    //     span and its children's spans may contain an identifier — identical ranges
    //     cannot gap (a fully synthetic cast would instead be stamped by the
    //     synthetic-descendant pass, which skips NodeArrays inconsistently and opens
    //     exactly such gaps);
    //   - POSITION LOOKUP: the cast must stay position-INVISIBLE, so the `as`
    //     expression chain is narrowed to the base token span — a lookup inside the
    //     `<...>` region falls past it to the pinned heritage type arguments.
    collapseSubtreeTextRange(tsInstance, castType, { pos: fullRange.pos, end: fullRange.end })

    // The heritage type-argument NodeArray spans the source argument region (or
    // anchors zero-width at the heritage end without one): getChildren reconstructs a
    // SyntaxList from NodeArray.pos, and a synthetic array would be stamped over the
    // whole span, breaking child ordering.
    if (extendsExpr.typeArguments !== undefined) {
        preserveTextRange(
            tsInstance,
            extendsExpr.typeArguments,
            argsRegion !== undefined ? { pos: argsRegion.pos, end: fullRange.end } : referenceAnchor
        )
    }

    // The `(base as unknown as <cast>)` chain owns exactly the base token span; the
    // `unknown` keyword anchors zero-width right after it. Everything after the base
    // tokens (`<...>`) belongs to the pinned heritage type arguments, so a position
    // there never descends into the cast.
    const baseEnd = baseExpression.end >= 0 ? baseExpression.end : fullRange.end

    preserveTextRange(tsInstance, innerAs, { pos: fullRange.pos, end: baseEnd })
    preserveTextRange(tsInstance, innerAs.type, zeroWidthRange(baseEnd))
    preserveTextRange(tsInstance, outerAs, { pos: fullRange.pos, end: baseEnd })

    // The factory parenthesizes the `as` chain under the type-argument list — the
    // wrapper must share the narrowed span, or its child gap strands the `<...>` text.
    if ((extendsExpr.expression as ts.Node) !== outerAs) {
        preserveTextRange(tsInstance, extendsExpr.expression, { pos: fullRange.pos, end: baseEnd })
    }

    preserveTextRange(tsInstance, extendsExpr, fullRange)

    const heritageClause = factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [ extendsExpr ])

    preserveTextRange(tsInstance, heritageClause.types, fullRange)

    return preserveTextRange(tsInstance, heritageClause, fullRange)
}

// The navigable clone of the source base expression, position-pinned so navigation
// lands on every token of it — each identifier on EXACTLY its own source token, so a
// find-all-references / rename span never swallows the `<...>` type-argument tail
// (the source type-argument nodes are reused inside the cast at their real
// positions, so that tail stays owned by positioned nodes; the stretched ancestors
// claim the punctuation between). A qualified base (`ns.Base`, arbitrarily deep)
// pins each qualifier step the same way — this is what the old shallow clone lacked
// (its inner `Base` sat at `[-1, -1]`, unreachable for navigation).
// The qualifier chain below the outermost name: every node keeps its exact source range.
function pinnedQualifierExpression(tsInstance: TypeScript, expression: ts.Expression): ts.Expression {
    if (tsInstance.isPropertyAccessExpression(expression) && tsInstance.isIdentifier(expression.name)) {
        return preserveTextRange(
            tsInstance,
            tsInstance.factory.createPropertyAccessExpression(
                pinnedQualifierExpression(tsInstance, expression.expression),
                preserveTextRange(tsInstance, cloneNode(tsInstance, expression.name), sourceRangeOf(expression.name))
            ),
            sourceRangeOf(expression)
        )
    }

    return preserveTextRange(tsInstance, cloneNode(tsInstance, expression), sourceRangeOf(expression))
}

// The node's real source range. The transform runs over a LAYERED CLONE of the source
// file whose factory clones drop positions ([-1, -1]) but keep `.original` links to the
// parse tree — walk them until a positioned node appears. A node with no positioned
// original anywhere (a transient edit state) is returned as-is: the pin degrades to the
// synthetic range, which the descendant-range pass later collapses onto the heritage
// span — the pre-fix behaviour.
function sourceRangeOf(node: ts.Node): ts.TextRange {
    let current: ts.Node | undefined = node

    while (current !== undefined && (current.pos < 0 || current.end < 0)) {
        current = (current as { original?: ts.Node }).original
    }

    return current ?? node
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
// `super.<mixinMember>`, `implements` and `override` (TS2720/TS4112).
//
// A GENERIC consumer's instance types reference the consumer's type parameters, which
// a base expression must not do (TS2562) — so the construct signature declares its
// OWN type parameters (clones of the consumer's, variance stripped), shadowing the
// class scope; the heritage instantiates them back via type arguments.
//
// A CONSTRUCTION consumer's head is the branded (or permissive) construct signature
// plus the base's `Omit<typeof Base, "prototype">` statics — exactly the `$base`
// cast head, except the construct returns the full base & mixins instance
// intersection (there is no `$base` interface to carry it here). The mapped-type
// `Omit` drops `typeof Base`'s public construct signature, keeping the cast single
// source.
// The single-source navigable cast. Its construct signature is generic when the
// consumer is generic OR the source base has type arguments: the consumer's own type
// parameters are cloned onto the signature (shadowing the class scope, dodging
// TS2562), and one INERT CARRIER parameter is appended per source base type argument
// — semantically unused, they exist so the heritage can pass the position-pinned
// argument clones as type arguments (class-scoped, navigation-visible) without
// disturbing the instantiation of the consumer parameters. The base/mixin instance
// references inside use fully synthetic deep clones (sharing the source nodes would
// let the cast's uniform stamp mutate the parse tree — the kept implements clause
// and the replaced extends both borrow from it).
function createNavigableConsumerBaseCastType(
    tsInstance: TypeScript,
    extendsType: ts.ExpressionWithTypeArguments,
    mixinHeritage: ts.ExpressionWithTypeArguments[],
    linearizedMixinRefs: ResolvedMixinRef[],
    typeParameters: readonly ts.TypeParameterDeclaration[] | undefined,
    construction: ConstructionBrand | undefined,
    extraStaticsTypes: ts.TypeNode[] = []
): { type: ts.TypeNode } {
    const factory = tsInstance.factory

    const clonedTypeReference = (heritageType: ts.ExpressionWithTypeArguments): ts.TypeNode =>
        factory.createTypeReferenceNode(
            expressionToEntityName(tsInstance, heritageType.expression),
            heritageType.typeArguments?.map((typeArgument) => deepCloneNode(tsInstance, typeArgument))
        )
    const instanceTypes       = [
        clonedTypeReference(extendsType),
        ...mixinHeritage.map(clonedTypeReference)
    ]
    const instanceType        = instanceTypes.length === 1
        ? instanceTypes[0]
        : factory.createIntersectionTypeNode(instanceTypes)
    const carrierParameters   = (extendsType.typeArguments ?? []).map((typeArgument, index) =>
        factory.createTypeParameterDeclaration(
            undefined,
            `__BaseTypeArgument${index}`,
            undefined,
            undefined
        ))
    const ownParameters       = (typeParameters ?? []).map((typeParameter) =>
        stripVarianceAnnotations(tsInstance, deepCloneNode(tsInstance, typeParameter)))
    // Carriers FIRST: the heritage passes the pinned source-argument clones first
    // (position order), the consumer parameters after — the signature must match.
    const signatureTypeParameters = ownParameters.length + carrierParameters.length === 0
        ? undefined
        : [ ...carrierParameters, ...ownParameters ]

    if (construction !== undefined) {
        return {
            type : factory.createIntersectionTypeNode([
                constructionHeadType(
                    tsInstance,
                    expressionToEntityName(tsInstance, extendsType.expression),
                    construction,
                    instanceType,
                    signatureTypeParameters
                ),
                ...mixinStaticsTypes(tsInstance, linearizedMixinRefs),
                ...extraStaticsTypes
            ])
        }
    }

    const instanceConstructor = signatureTypeParameters === undefined
        ? factory.createTypeReferenceNode(anyConstructorName, [ instanceType ])
        : factory.createConstructorTypeNode(
            undefined,
            signatureTypeParameters,
            [ factory.createParameterDeclaration(
                undefined,
                factory.createToken(tsInstance.SyntaxKind.DotDotDotToken),
                "args",
                undefined,
                factory.createArrayTypeNode(factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword))
            ) ],
            instanceType
        )
    const staticsTypes        = [
        createStaticsBag(tsInstance, expressionToEntityName(tsInstance, extendsType.expression)),
        ...mixinStaticsTypes(tsInstance, linearizedMixinRefs),
        ...extraStaticsTypes
    ]

    return {
        type : factory.createIntersectionTypeNode([ instanceConstructor, ...staticsTypes ])
    }
}

// `Omit<typeof <entity>, "prototype" | "new" | "mix">`: an entity's static side as a plain
// property bag, with no construct signature (see createNavigableConsumerBaseCastType).
// `mix` is excluded like `new`: it is installed on mixin VALUES only (`defineMixinClass`),
// never inherited by consumers at runtime, so carrying it in the consumer's static type is a
// type lie — and it blocks a consumer's own `static mix` with a TS2417 override conflict
// (same failure mode the `new` exclusion prevents; a mixin's own dependency statics already
// exclude `mix` — see the metadata-base `Omit` in mixin-expand).
function createStaticsBag(tsInstance: TypeScript, entityName: ts.EntityName): ts.TypeNode {
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
