import type * as ts from "typescript"
import {
    anyConstructorName,
    classStaticsName,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import type { LinearizationPlanSlice } from "./linearization.js"

// The runtime `LinearizationMode` (a magic string) the compiler bakes into the emit, derived
// from the build environment (read in resolveTransformOptions). The plan is ALWAYS emitted;
// the mode only changes what the runtime does with it. Always one of the three explicit
// modes — "verify" (default), "replay" (production), "c3" (escape hatch) — kept here so the
// mixin and consumer emit paths agree.
export function linearizationMode(options: TransformOptions): "verify" | "replay" | "c3" {
    return options.disableLinearizationPlan
        ? "c3"
        : options.verifyLinearization
            ? "verify"
            : "replay"
}
import {
    deepCloneNode,
    preserveSubtreeTextRange,
    preserveTextRange,
    zeroWidthRange
} from "./util.js"
import type { TypeScript } from "./util.js"

export class MixinTransformError extends Error {
    constructor (sourceFile: ts.SourceFile, node: ts.Node | ts.PropertyName, message: string) {
        const position = nodePosition(sourceFile, node)

        super(`${sourceFile.fileName}${position}: ${message}`)
    }
}

function nodePosition(sourceFile: ts.SourceFile, node: ts.Node): string {
    const start = node.getStart?.(sourceFile)

    if (start === undefined || start < 0) {
        return ""
    }

    const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)

    return `(${line + 1},${character + 1})`
}

export function cloneExpressionWithTypeArguments(
    tsInstance: TypeScript,
    expression: ts.ExpressionWithTypeArguments
): ts.ExpressionWithTypeArguments {
    return tsInstance.factory.createExpressionWithTypeArguments(
        deepCloneNode(tsInstance, expression.expression),
        expression.typeArguments?.map((typeArgument) => deepCloneNode(tsInstance, typeArgument))
    )
}

// A single type is returned as-is; two or more are wrapped in an intersection. Callers
// pass a non-empty list (a head type plus optional extras), so the empty case is not
// expected — kept here as the one place that decides "intersect only when needed".
export function intersectionOrSingle(
    tsInstance: TypeScript,
    types: ts.TypeNode[]
): ts.TypeNode {
    return types.length === 1 ? types[0] : tsInstance.factory.createIntersectionTypeNode(types)
}

// Walk `typeNode`, replacing each bare type reference (an identifier type name with no
// type arguments) for which `replace` returns a node; references `replace` maps to
// `undefined` are left as-is. Returns a position-less rewritten type. Shared by the
// mixin's own-type-parameter erasure (-> `any`) and the consumer config substitution
// (-> the consumer's `implements` type argument).
export function rewriteTypeReferences(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    replace: (name: string) => ts.TypeNode | undefined
): ts.TypeNode {
    const result = tsInstance.transform(typeNode, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                if (tsInstance.isTypeReferenceNode(node) &&
                    tsInstance.isIdentifier(node.typeName) &&
                    node.typeArguments === undefined) {
                    const replacement = replace(node.typeName.text)

                    if (replacement !== undefined) {
                        return replacement
                    }
                }

                return tsInstance.visitEachChild(node, visit, context)
            }

            return (node) => tsInstance.visitNode(node, visit) as ts.TypeNode
        }
    ])

    try {
        return result.transformed[0]
    } finally {
        result.dispose()
    }
}

export function heritageTypeToTypeReference(
    tsInstance: TypeScript,
    heritageType: ts.ExpressionWithTypeArguments
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createTypeReferenceNode(
        expressionToEntityName(tsInstance, heritageType.expression),
        heritageType.typeArguments
    )
}

export function heritageTypeText(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    heritageType: ts.ExpressionWithTypeArguments
): string {
    if (heritageType.pos >= 0 && heritageType.end >= 0) {
        return heritageType.getText(sourceFile)
    }

    if (tsInstance.isIdentifier(heritageType.expression) || tsInstance.isPropertyAccessExpression(heritageType.expression)) {
        const typeArguments = heritageType.typeArguments === undefined || heritageType.typeArguments.length === 0
            ? ""
            : "<...>"

        return `${heritageType.expression.getText(sourceFile)}${typeArguments}`
    }

    return "<base class>"
}

export function createDiagnosticLiteralType(
    tsInstance: TypeScript,
    message: string
): ts.LiteralTypeNode {
    return tsInstance.factory.createLiteralTypeNode(tsInstance.factory.createStringLiteral(message))
}

// Placeholder entity used when a heritage expression is not a plain reference (an
// identifier or qualified name). This only happens in a transient mid-edit state — e.g.
// a deletion momentarily leaves a `@mixin` class's `implements`/`extends` as a string
// literal or call — which the language service re-transforms on the next keystroke. We
// must NOT throw there (it crashes tsserver mid-typing; the `stress-edit` contract is that
// the transform survives any edit), so we degrade to a placeholder name. It surfaces as a
// transient "cannot find name" at worst, never a crash. The principled entry points
// (`requiredBaseType`, the consumer base guard) still filter unsupported bases via
// `isSupportedBaseExpression`, so a *settled* program never reaches this fallback.
const unsupportedBaseEntityName = "__tsMixinClassUnsupportedBase"

export function expressionToEntityName(tsInstance: TypeScript, expression: ts.Expression): ts.EntityName {
    if (tsInstance.isIdentifier(expression)) {
        return tsInstance.factory.createIdentifier(expression.text)
    }

    if (tsInstance.isPropertyAccessExpression(expression) && tsInstance.isIdentifier(expression.name)) {
        return tsInstance.factory.createQualifiedName(
            expressionToEntityName(tsInstance, expression.expression),
            expression.name.text
        )
    }

    return tsInstance.factory.createIdentifier(unsupportedBaseEntityName)
}

export function mixinValueIdentifier(tsInstance: TypeScript, ref: ResolvedMixinRef): ts.Identifier {
    if (ref.localValueName === undefined) {
        throw new Error(`Mixin value ${ref.className} is not available in the transformed file`)
    }

    return tsInstance.factory.createIdentifier(ref.localValueName)
}

// Emit a precomputed merge plan as an array-of-triples literal `[[s, o, l], ...]`, the
// runtime `LinearizationPlan` (approach B). The integers ride alone -- the mixin VALUES
// they slice are reached through the dependency arrays already passed alongside the plan.
export function createLinearizationPlanLiteral(
    tsInstance: TypeScript,
    plan: LinearizationPlanSlice[]
): ts.ArrayLiteralExpression {
    const factory = tsInstance.factory

    return factory.createArrayLiteralExpression(
        plan.map((slice) => factory.createArrayLiteralExpression(
            slice.map((value) => factory.createNumericLiteral(value))
        ))
    )
}

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

// Describes the construct signature a construction consumer's `$base` cast head should
// carry. `branded` consumers (the cooperative `initialize` pattern, no own constructor)
// get a poisoned construct so `new Consumer(...)` is a type error; an unbranded
// construction consumer (one that declares its own constructor, opting into manual
// construction) gets a permissive `new (...args)` construct instead, so its
// `super(...)` call keeps working even when the base is itself a branded construction
// class (whose `typeof Base` construct would otherwise require the brand argument).
export type ConstructionBrand = {
    consumerName : string,
    branded      : boolean
}

// The "construction base head" used in a construction consumer's `$base` cast. The
// base's statics are kept (inline `Omit<typeof Base, "prototype">` drops the public
// construct signature), and a single construct signature is added back: BRANDED so that
// `new Consumer(...)` is a type error, or permissive (`new (...args: any[])`) for a
// manual-constructor consumer. The construct returns the base instance so the generated
// `$base` class can still `extends` the cast. The brand is only a parameter type, not a
// `protected` constructor, so the class value stays assignable to a public
// `AnyConstructor` slot (`.mix(...)`, `instanceof`-style helpers keep working).
export function constructionHeadType(
    tsInstance: TypeScript,
    baseEntity: ts.EntityName,
    construction: ConstructionBrand,
    // The construct signature's return (instance) type: the precise base heritage type
    // (`Base`, `GenericBase<T>`, `GenericBase<string>`). The emit `$base` interface does
    // not re-extend a base without type arguments, so the consumer's base instance
    // members (e.g. `initialize`, the base's own fields) flow only through this return —
    // `object` would drop them. For a generic base the type argument matches the `$base`
    // interface's own `extends GenericBase<T>`, so the two agree (no `unknown`).
    instanceReturnType: ts.TypeNode
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createIntersectionTypeNode([
        constructionConstructSignatureType(tsInstance, construction, instanceReturnType),
        // Inline `Omit<typeof Base, "prototype">` (not the `ClassStatics` alias) so the
        // construction-base path, which does not request generated imports, needs none:
        // `Omit` is a global lib utility. This keeps the base's statics while the mapped
        // type drops the public construct signature, leaving the one added above as the
        // only construct signature.
        factory.createTypeReferenceNode("Omit", [
            factory.createTypeQueryNode(baseEntity),
            factory.createLiteralTypeNode(factory.createStringLiteral("prototype"))
        ])
    ])
}

// `new (use_the_static_new_factory: { readonly "<guidance>": never }) => <returnType>`
// when branded, else a permissive `new (...args: any[]) => <returnType>`.
function constructionConstructSignatureType(
    tsInstance: TypeScript,
    construction: ConstructionBrand,
    returnType: ts.TypeNode
): ts.TypeNode {
    const factory = tsInstance.factory

    const parameter = construction.branded
        ? factory.createParameterDeclaration(
            undefined,
            undefined,
            "use_the_static_new_factory",
            undefined,
            constructorBrandType(tsInstance, construction.consumerName)
        )
        : factory.createParameterDeclaration(
            undefined,
            factory.createToken(tsInstance.SyntaxKind.DotDotDotToken),
            "args",
            undefined,
            factory.createArrayTypeNode(factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword))
        )

    return factory.createConstructorTypeNode(undefined, undefined, [ parameter ], returnType)
}

function constructorBrandType(tsInstance: TypeScript, consumerName: string): ts.TypeNode {
    const factory = tsInstance.factory
    const message =
        `Use \`${consumerName}.new({ ... })\` to construct - ` +
        `direct \`new ${consumerName}(...)\` is disabled; construction runs through the generated static \`new\` factory`

    return factory.createTypeLiteralNode([
        factory.createPropertySignature(
            [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ],
            factory.createStringLiteral(message),
            undefined,
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
        )
    ])
}

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

    const extendsType = preserveTextRange(tsInstance, factory.createExpressionWithTypeArguments(
        factory.createIdentifier(baseName),
        typeArguments
    ), generatedTypeRange)

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

    const extendsHeritage = preserveTextRange(tsInstance, factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        extendsType
    ]), generatedRange)

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
