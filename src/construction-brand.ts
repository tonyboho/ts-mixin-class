import type * as ts from "typescript"
import { preserveTextRange } from "./text-range.js"
import type { TypeScript } from "./util.js"

// The construction "brand": the poisoned (or permissive) construct signature that makes a
// direct `new X(...)` a type error while construction runs through the generated static
// `new` factory. Shared by both planes and both class kinds — the consumer's `$base` cast
// head, the navigable fast-path cast, the construction-mixin value cast and the
// manual-constructor parameter branding all reuse the one signature builder, so the
// disabled-`new` message and behaviour stay identical everywhere.

// Describes the construct signature a construction consumer's `$base` cast head should
// carry. `branded` consumers (the cooperative `initialize` pattern, no own constructor)
// get a poisoned construct so `new Consumer(...)` is a type error; an unbranded
// construction consumer (one that declares its own constructor, opting into manual
// construction) gets a permissive `new (...args)` construct instead, so its
// `super(...)` call keeps working even when the base is itself a branded construction
// class (whose `typeof Base` construct would otherwise require the brand argument).
export type ConstructionBrand = {
    consumerName            : string,
    branded                 : boolean,
    // Also omit the inherited `static new` from the base-statics head: set when this
    // class's `.new` parameter is REQUIRED while the provably-empty base's `.new` takes
    // the exact-empty idiom (§7.25) — assignable in neither bivariance direction, so the
    // inherited member would be a guaranteed TS2417. The class declares its own
    // `static new`, so omitting loses nothing.
    omitInheritedStaticNew? : boolean
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
    instanceReturnType: ts.TypeNode,
    // Makes the construct signature generic — the navigable fast path of a GENERIC
    // consumer threads the consumer's type parameters through the signature (the
    // instance return references them; declaring them on the signature keeps them out
    // of the base expression scope, dodging TS2562).
    typeParameters?: readonly ts.TypeParameterDeclaration[]
): ts.TypeNode {
    const factory = tsInstance.factory

    return factory.createIntersectionTypeNode([
        constructionConstructSignatureType(tsInstance, construction, instanceReturnType, typeParameters),
        // Inline `Omit<typeof Base, "prototype">` (not the `ClassStatics` alias) so the
        // construction-base path, which does not request generated imports, needs none:
        // `Omit` is a global lib utility. This keeps the base's statics while the mapped
        // type drops the public construct signature, leaving the one added above as the
        // only construct signature. For a provably-empty base under a required-config
        // class (see ConstructionBrand) the inherited `static new` is replaced by a
        // permissive `"new"(props?: any): unknown` member: the exact-empty parameter
        // would TS2417 against the subclass's required one, while the replacement stays
        // bivariance-compatible with any config AND keeps the generated implementation
        // overload's `super.new(props)` forwarding typed.
        ...(construction.omitInheritedStaticNew === true
            ? [
                factory.createTypeReferenceNode("Omit", [
                    factory.createTypeQueryNode(baseEntity),
                    factory.createUnionTypeNode([
                        factory.createLiteralTypeNode(factory.createStringLiteral("prototype")),
                        factory.createLiteralTypeNode(factory.createStringLiteral("new"))
                    ])
                ]),
                factory.createTypeLiteralNode([
                    factory.createMethodSignature(
                        undefined,
                        factory.createStringLiteral("new"),
                        undefined,
                        undefined,
                        [ factory.createParameterDeclaration(
                            undefined,
                            undefined,
                            "props",
                            factory.createToken(tsInstance.SyntaxKind.QuestionToken),
                            factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                        ) ],
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    )
                ])
            ]
            : [
                factory.createTypeReferenceNode("Omit", [
                    factory.createTypeQueryNode(baseEntity),
                    factory.createLiteralTypeNode(factory.createStringLiteral("prototype"))
                ])
            ])
    ])
}

// `new (use_the_static_new_factory: { readonly "<guidance>": never }) => <returnType>`
// when branded, else a permissive `new (...args: any[]) => <returnType>`. Optional
// `typeParameters` make the construct signature generic (`new <T>(...) => Repo<T>` — a
// generic construction mixin's poisoned construct must bind the instance type's parameter).
function constructionConstructSignatureType(
    tsInstance: TypeScript,
    construction: ConstructionBrand,
    returnType: ts.TypeNode,
    typeParameters?: readonly ts.TypeParameterDeclaration[]
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

    return factory.createConstructorTypeNode(undefined, typeParameters, [ parameter ], returnType)
}

// The poisoned construct signature `new (use_the_static_new_factory: { readonly "<guidance>": never })
// => returnType` on its own, for callers (the construction-mixin value cast) that brand `new` without
// the consumer's `Omit<typeof Base, "prototype">` statics head. Reuses the consumer brand verbatim so
// the disabled-`new` message and behaviour are identical across the mixin and consumer planes.
export function brandedConstructSignatureType(
    tsInstance: TypeScript,
    name: string,
    returnType: ts.TypeNode,
    typeParameters?: readonly ts.TypeParameterDeclaration[]
): ts.TypeNode {
    return constructionConstructSignatureType(tsInstance, { consumerName: name, branded: true }, returnType, typeParameters)
}

// Prepend a poisoned, REQUIRED first parameter to a class's own constructor so an external
// `new X(...)` is a type error (it must supply the brand, which has no constructible value), while
// the constructor's own `super()` — targeting the UNBRANDED `$base` — and the static `.new()` keep
// type-checking. Used for a construction class that declares its OWN constructor, where branding the
// `$base` head would instead break that `super()`. The constructor stays public, so the class value
// remains assignable to a public `AnyConstructor` slot (`.mix(...)`), unlike a `protected` ctor.
//
// Inserts visible text into the constructor's parameter list, so it is EMIT-only: the emit path
// reprints and remaps diagnostics, absorbing the shift, whereas source view is position-preserving
// and the inserted parameter would drift the constructor body's navigation.
export function brandConstructorParameter(
    tsInstance: TypeScript,
    members: ts.NodeArray<ts.ClassElement>,
    className: string
): ts.NodeArray<ts.ClassElement> {
    const factory = tsInstance.factory
    let changed   = false

    const updated = members.map((member) => {
        if (!tsInstance.isConstructorDeclaration(member)) {
            return member
        }

        changed = true

        return factory.updateConstructorDeclaration(
            member,
            member.modifiers,
            [
                factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    "use_the_static_new_factory",
                    undefined,
                    constructorBrandType(tsInstance, className)
                ),
                ...member.parameters
            ],
            member.body
        )
    })

    return changed
        ? preserveTextRange(tsInstance, factory.createNodeArray(updated), members)
        : members
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
