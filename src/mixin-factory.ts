import type * as ts from "typescript"
import { fillMissedInitializers } from "./construction-initializers.js"
import { addSyntheticSuperCallToConstructors } from "./consumer-constructors.js"
import {
    anyConstructorName,
    classStaticsName,
    implementsTypes,
    isNamedClassElement,
    constructionMixinClassValueName,
    mixinClassValueName,
    mixinFactoryName,
    requiredBaseType,
    runtimeMixinClassName,
    type FileMixinContext,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { brandedConstructSignatureType } from "./construction-brand.js"
import {
    cloneExpressionWithTypeArguments,
    dottedNameToEntityName,
    expressionToEntityName,
    heritageTypeToTypeReference,
    rewriteTypeReferences
} from "./expand-util.js"
import { createMixinApplyType } from "./mixin-apply-type.js"
import {
    isSupportedMixinClassMember
} from "./mixin-diagnostics.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import { reduceTransitiveMixinHeritageTypes } from "./transitive-heritage-workaround.js"
import { deepCloneNode, hasModifier, stripVarianceAnnotations } from "./util.js"
import { preserveTextRange } from "./text-range.js"
import type { TypeScript } from "./util.js"

// The EMIT-plane builders of a mixin's three-declaration expansion: the runtime FACTORY
// expression (`const __X$mixin = function (base) { class __X$class extends base {...} ... }`,
// with its statics bag and isolated-declarations return annotation), the branded VALUE CAST
// (`const X = __X$mixin(Object) as unknown as ...`, incl. the RuntimeMixinClass metadata
// type), and the shared heritage/base-parameter tail. The orchestrator and the source-view
// plane live in `mixin-expand.ts` / `mixin-source-view.ts`.

export function createMixinFactoryExpression(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    typeParameters: ts.TypeParameterDeclaration[] | undefined,
    runtimeClassName: string,
    context: FileMixinContext,
    options: TransformOptions
): ts.FunctionExpression {
    const factory = tsInstance.factory

    // The runtime class is a named DECLARATION (`class __X$class extends base { … }` +
    // `return __X$class`), NOT a `return class …` expression: legacy `experimentalDecorators`
    // are invalid on class-EXPRESSION members (TS1206), so a declaration is the only shape
    // that keeps a mixin's member decorators legal in both decorator modes. The synthetic
    // name never leaks — self-references inside the body still bind to the OUTER mixin const
    // (no shadowing), and the runtime renames every application via `setClassName`.
    //
    // Both the declaration and its name are pinned to the mixin's source name: TS2420
    // ("incorrectly implements") on a class declaration is reported at the class NAME, so the
    // pin places it on the mixin's declaration line — without it the synthetic (pos -1) name
    // has no real position for the diagnostic (and the emit source map would drift the class
    // onto whatever entry happens to precede it).
    const runtimeClass = preserveTextRange(
        tsInstance,
        factory.createClassDeclaration(
            undefined,
            preserveTextRange(
                tsInstance,
                factory.createIdentifier(runtimeClassName),
                declaration.name ?? declaration
            ),
            undefined,
            mixinFactoryHeritageClauses(tsInstance, declaration),
            mixinRuntimeMembers(tsInstance, sourceFile, declaration, options)
        ),
        declaration.name ?? declaration
    )

    // The explicit return annotation exists ONLY under `isolatedDeclarations` (where the
    // inferred return is a TS9007 on the exported factory). It is not always-on: its
    // inherited-statics tail references dependency VALUE types whose own annotations nest
    // further — `Omit<ClassStatics<…>>` chains that hit the checker's instantiation-depth
    // ceiling (TS2589) on deep dependency windows. The default inferred `typeof __X$class`
    // is a flat class type with none of that nesting.
    const returnAnnotation = options.isolatedDeclarations
        ? createFactoryReturnType(tsInstance, declaration, typeParameters, context)
        : undefined

    return factory.createFunctionExpression(
        undefined,
        undefined,
        undefined,
        typeParameters?.map((typeParameter) => stripVarianceAnnotations(tsInstance, typeParameter)),
        [ createBaseParameter(tsInstance, declaration, context) ],
        returnAnnotation,
        factory.createBlock(
            [
                runtimeClass,
                // Under the annotation the return is CAST to it (built fresh — AST nodes are
                // single-parent): checking `typeof __X$class` against `AnyConstructor<X>`
                // structurally would reject a mixin whose interface gained TRUSTED members through
                // declaration merging (the class legitimately does not implement them); the real
                // body-vs-contract checking lives on the runtime class's own `implements` clause.
                factory.createReturnStatement(returnAnnotation === undefined
                    ? factory.createIdentifier(runtimeClassName)
                    : factory.createAsExpression(
                        factory.createAsExpression(
                            factory.createIdentifier(runtimeClassName),
                            factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                        ),
                        createFactoryReturnType(tsInstance, declaration, typeParameters, context)
                    ))
            ],
            true
        )
    )
}

// The factory's EXPLICIT return annotation: `AnyConstructor<X<T>> & { …own statics… } &
// ClassStatics<typeof Req> & Omit<ClassStatics<typeof Dep>, …>`. Written out so the exported
// factory satisfies `isolatedDeclarations` (an inferred return type is TS9007 on every
// `@mixin` under that option). The annotation must restate everything the inferred
// `typeof __X$class` carried, because the value cast reads statics through
// `ReturnType<typeof __X$mixin>`: the instance side (the generated `interface X`), the
// mixin's OWN statics (a faithful literal from the declared members — possible because mixin
// members require explicit annotations), and the statics inherited from the required base /
// dependencies (the same nodes as the base parameter's tail).
function createFactoryReturnType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    typeParameters: ts.TypeParameterDeclaration[] | undefined,
    context: FileMixinContext
): ts.TypeNode {
    const factory      = tsInstance.factory
    const instanceType = factory.createTypeReferenceNode(
        declaration.name === undefined ? "never" : declaration.name.text,
        typeParameters?.map((typeParameter) => factory.createTypeReferenceNode(typeParameter.name, undefined))
    )
    // A mixin declaring its OWN constructor keeps its real construct signature in the
    // annotation (`new (tag?: string) => X`), like the inferred type did — downstream
    // `ConstructorParameters<ReturnType<…>>` readers stay accurate. A parameter with an
    // initializer surfaces as OPTIONAL, exactly as inference rendered it.
    const ownConstructor = declaration.members.find(
        (member): member is ts.ConstructorDeclaration => tsInstance.isConstructorDeclaration(member)
    )
    const head           = ownConstructor === undefined
        ? factory.createTypeReferenceNode(anyConstructorName, [ instanceType ])
        : factory.createParenthesizedType(factory.createConstructorTypeNode(
            undefined,
            undefined,
            ownConstructor.parameters.map((parameter) => cloneFactorySignatureParameter(tsInstance, parameter)),
            instanceType
        ))
    const staticsLiteral = createFactoryStaticsLiteral(tsInstance, declaration)
    // Inherited statics the class's OWN statics shadow are omitted — class semantics: an own
    // `static new` REPLACES the base's inherited one; a plain intersection would instead keep
    // the base's permissive signature as a live overload.
    const inheritedTail = baseStaticsTypes(tsInstance, declaration, context, ownStaticMemberNames(tsInstance, declaration))
    const parts         = [
        head,
        ...(staticsLiteral.members.length === 0 ? [] : [ staticsLiteral ]),
        ...inheritedTail
    ]

    return parts.length === 1 ? head : factory.createIntersectionTypeNode(parts)
}

// The names of the class's own statics — the keys its static side SHADOWS in whatever it
// inherits (used to Omit them from the annotation's inherited-statics tail).
function ownStaticMemberNames(tsInstance: TypeScript, declaration: ts.ClassDeclaration): string[] {
    return declaration.members.flatMap((member) => {
        if (!hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
            member.name === undefined ||
            !(tsInstance.isIdentifier(member.name) || tsInstance.isStringLiteral(member.name))
        ) {
            return []
        }

        return [ member.name.text ]
    })
}

// A signature-position clone of a declaration parameter: modifiers (parameter properties)
// dropped, an INITIALIZER surfaces as `?` (optional in the signature), types cloned.
function cloneFactorySignatureParameter(
    tsInstance: TypeScript,
    source: ts.ParameterDeclaration
): ts.ParameterDeclaration {
    const factory = tsInstance.factory

    return factory.createParameterDeclaration(
        undefined,
        source.dotDotDotToken === undefined ? undefined : deepCloneNode(tsInstance, source.dotDotDotToken),
        deepCloneNode(tsInstance, source.name),
        source.questionToken !== undefined || source.initializer !== undefined
            ? factory.createToken(tsInstance.SyntaxKind.QuestionToken)
            : undefined,
        source.type === undefined
            ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            : deepCloneNode(tsInstance, source.type),
        undefined
    )
}

// The mixin's OWN static surface as a type literal, member for member. A static named `new`
// gets a STRING-LITERAL member name: the emit plane REPRINTS the tree to text, and a reparsed
// `new(…): X` inside a type literal is a CONSTRUCT signature, not a method named "new" —
// `"new"(…): X` survives the round-trip. Accessors keep their get/set shape (a get-only static
// stays read-only through `typeof Mixin`); an auto-accessor is a plain writable property.
function createFactoryStaticsLiteral(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeLiteralNode {
    const factory = tsInstance.factory

    const memberName = (name: ts.PropertyName): ts.PropertyName => {
        if (tsInstance.isIdentifier(name) && name.text === "new") {
            return factory.createStringLiteral("new")
        }

        return deepCloneNode(tsInstance, name)
    }

    const parameter = (source: ts.ParameterDeclaration): ts.ParameterDeclaration => {
        return factory.createParameterDeclaration(
            undefined,
            source.dotDotDotToken === undefined ? undefined : deepCloneNode(tsInstance, source.dotDotDotToken),
            deepCloneNode(tsInstance, source.name),
            source.questionToken === undefined ? undefined : deepCloneNode(tsInstance, source.questionToken),
            source.type === undefined
                ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                : deepCloneNode(tsInstance, source.type),
            undefined
        )
    }

    return factory.createTypeLiteralNode(declaration.members.flatMap((member): ts.TypeElement[] => {
        if (!hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) ||
            member.name === undefined ||
            tsInstance.isPrivateIdentifier(member.name)
        ) {
            return []
        }

        if (tsInstance.isPropertyDeclaration(member)) {
            const readonly = !hasModifier(tsInstance, member, tsInstance.SyntaxKind.AccessorKeyword) &&
                hasModifier(tsInstance, member, tsInstance.SyntaxKind.ReadonlyKeyword)

            return [ factory.createPropertySignature(
                readonly ? [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ] : undefined,
                memberName(member.name),
                member.questionToken === undefined ? undefined : deepCloneNode(tsInstance, member.questionToken),
                member.type === undefined
                    ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                    : deepCloneNode(tsInstance, member.type)
            ) ]
        }

        if (tsInstance.isMethodDeclaration(member)) {
            return [ factory.createMethodSignature(
                undefined,
                memberName(member.name),
                member.questionToken === undefined ? undefined : deepCloneNode(tsInstance, member.questionToken),
                member.typeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter)),
                member.parameters.map(parameter),
                member.type === undefined
                    ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                    : deepCloneNode(tsInstance, member.type)
            ) ]
        }

        if (tsInstance.isGetAccessorDeclaration(member)) {
            return [ factory.createGetAccessorDeclaration(
                undefined,
                memberName(member.name),
                [],
                member.type === undefined
                    ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                    : deepCloneNode(tsInstance, member.type),
                undefined
            ) ]
        }

        if (tsInstance.isSetAccessorDeclaration(member)) {
            return [ factory.createSetAccessorDeclaration(
                undefined,
                memberName(member.name),
                member.parameters.map(parameter),
                undefined
            ) ]
        }

        return []
    }))
}

// Heritage of the factory's inner runtime class: `extends base`, plus the mixin's own
// `implements` contracts. The `implements` clause is type-only (erased in JS), so it
// adds no runtime code — but it makes the checker verify the *real* runtime body against
// each contract, the check the value-cast (`as unknown as`) otherwise erases. `base` is
// typed `AnyConstructor<RequiredBase & deps>`, so members the contract inherits from the
// required base / dependencies are satisfied through `extends base`, exactly as source
// view's real class is. Works uniformly for generic and non-generic mixins (the mixin's
// type parameters are in scope inside the factory).
function mixinFactoryHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.HeritageClause[] {
    const factory       = tsInstance.factory
    const contracts     = implementsTypes(tsInstance, declaration)
    const extendsClause = factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
        factory.createExpressionWithTypeArguments(factory.createIdentifier("base"), undefined)
    ])

    if (contracts.length === 0) {
        return [ extendsClause ]
    }

    return [
        extendsClause,
        factory.createHeritageClause(
            tsInstance.SyntaxKind.ImplementsKeyword,
            contracts.map((contract) => cloneExpressionWithTypeArguments(tsInstance, contract))
        )
    ]
}

function mixinRuntimeMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    options: TransformOptions
): ts.NodeArray<ts.ClassElement> {
    const members = tsInstance.factory.createNodeArray(declaration.members.filter((member) => {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) ||
            isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)
        ) {
            return false
        }

        return isSupportedMixinClassMember(tsInstance, member)
    }))

    // The mixin's own constructor is preserved (the declaration is allowed). The factory wraps it
    // as `class extends base`, so a constructor written without `super()` (the source mixin has no
    // `extends`) needs a synthetic no-arg `super()` to be a valid derived constructor and to chain
    // through the linearized bases — the same convention as consumer constructors.
    const withSuper = addSyntheticSuperCallToConstructors(tsInstance, sourceFile, members, true)

    return fillMissedInitializers(tsInstance, withSuper, options)
}

export function asMixinFactory(tsInstance: TypeScript, expression: ts.Expression): ts.Expression {
    return tsInstance.factory.createAsExpression(
        tsInstance.factory.createAsExpression(
            expression,
            tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
        ),
        tsInstance.factory.createTypeReferenceNode(mixinFactoryName, undefined)
    )
}

// Static type cast for a mixin value. Non-generic mixins use the shared
// `MixinClassValue<Instance, typeof factory[, RequiredBase]>` alias (collapsing
// the constructor + ClassStatics + `mix` intersection that otherwise dominates
// emitted output). `& RuntimeMixinClass` stays a visible sibling so the .d.ts
// mixin marker is unchanged. Generic mixins keep the inline form, since their
// constructor and `mix` capture the mixin's own type parameters.
export function createMixinValueCastType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    ref: ResolvedMixinRef,
    typeParameters: ts.TypeParameterDeclaration[] | undefined,
    constructionNewType?: ts.TypeNode
): ts.TypeNode {
    const factory           = tsInstance.factory
    const instanceType      = factory.createTypeReferenceNode(
        ref.className,
        typeParameters?.map((typeParameter) => {
            return factory.createTypeReferenceNode(typeParameter.name, undefined)
        })
    )
    const factoryReturnType = factory.createTypeReferenceNode("ReturnType", [
        factory.createTypeQueryNode(factory.createIdentifier(ref.localFactoryName))
    ])

    if (typeParameters !== undefined) {
        // A generic CONSTRUCTION mixin: the generated `"new"<T>` comes first (so it wins over
        // anything inherited), and the permissive construct is swapped for the branded one —
        // direct `new Mixin<T>()` is a type error, exactly like the non-generic form below.
        const constructSignature = constructionNewType !== undefined
            ? factory.createParenthesizedType(brandedConstructSignatureType(
                tsInstance,
                ref.className,
                instanceType,
                typeParameters.map((typeParameter) => stripVarianceAnnotations(tsInstance, typeParameter))
            ))
            : factory.createParenthesizedType(factory.createConstructorTypeNode(
                undefined,
                typeParameters.map((typeParameter) => stripVarianceAnnotations(tsInstance, typeParameter)),
                [ factory.createParameterDeclaration(
                    undefined,
                    factory.createToken(tsInstance.SyntaxKind.DotDotDotToken),
                    "args",
                    undefined,
                    factory.createArrayTypeNode(factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword))
                ) ],
                instanceType
            ))

        // A generic CONSTRUCTION mixin drops the `new` inherited through the factory statics
        // (the base parameter carries the required base's static side, so `ReturnType<factory>`
        // inherits the permissive `Base.new` — it would win overload fallback next to the
        // generated `"new"<T>`), mirroring the non-generic `ConstructionMixinClassValue` omit.
        const factoryStatics = factory.createTypeReferenceNode(classStaticsName, [ factoryReturnType ])

        return factory.createIntersectionTypeNode([
            ...(constructionNewType !== undefined ? [ constructionNewType ] : []),
            constructSignature,
            constructionNewType === undefined
                ? factoryStatics
                : factory.createTypeReferenceNode("Omit", [
                    factoryStatics,
                    factory.createLiteralTypeNode(factory.createStringLiteral("new"))
                ]),
            createMixinApplyType(tsInstance, declaration, typeParameters, instanceType, factoryReturnType),
            createRuntimeMixinClassType(tsInstance, declaration)
        ])
    }

    const requiredBase     = requiredBaseType(tsInstance, declaration)
    const requiredBaseArgs = requiredBase === undefined
        ? []
        : [ heritageTypeToTypeReference(tsInstance, requiredBase) ]

    // A construction (Base-deriving) mixin: direct `new Mixin(...)` is a type error (construction
    // goes through the static `.new`), exactly like a construction consumer. The bare construct
    // signature is dropped (`ConstructionMixinClassValue`) and a poisoned, brand-carrying construct
    // is added instead. A base-less / required-base (non-package-Base) mixin keeps the permissive
    // `MixinClassValue` construct, so its direct `new` stays allowed.
    if (constructionNewType !== undefined) {
        return factory.createIntersectionTypeNode([
            // The mixin's own static `.new` comes first so it wins over the `Base.new` inherited
            // through the value, and the branded construct poisons `new Mixin(...)`.
            constructionNewType,
            brandedConstructSignatureType(tsInstance, ref.className, instanceType),
            factory.createTypeReferenceNode(constructionMixinClassValueName, [
                instanceType,
                factory.createTypeQueryNode(factory.createIdentifier(ref.localFactoryName)),
                ...requiredBaseArgs
            ]),
            createRuntimeMixinClassType(tsInstance, declaration)
        ])
    }

    return factory.createIntersectionTypeNode([
        factory.createTypeReferenceNode(mixinClassValueName, [
            instanceType,
            factory.createTypeQueryNode(factory.createIdentifier(ref.localFactoryName)),
            ...requiredBaseArgs
        ]),
        createRuntimeMixinClassType(tsInstance, declaration)
    ])
}

export function createRuntimeMixinClassType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeReferenceNode {
    const requiredBase = requiredBaseType(tsInstance, declaration)

    return tsInstance.factory.createTypeReferenceNode(
        runtimeMixinClassName,
        requiredBase === undefined
            ? undefined
            // The required-base argument is only the `[base]` marker of
            // `RuntimeMixinClass` (consumer enforcement lives in the generated
            // `interface … extends RequiredBase`, the `mix` signature, and
            // consumer-diagnostics — not here). A required base that forwards the
            // mixin's own type parameter (`@mixin class M<T> extends Base<T>`) would
            // otherwise leak `T` into a position with no enclosing generic scope:
            // emit's top-level value-cast intersection (TS2304 "Cannot find name 'T'")
            // and source view's `$base` base-class *expression* (TS2562 "Base class
            // expressions cannot reference class type parameters"). Erase forwarded
            // type-parameter references to `any` so the marker stays well-formed in
            // both paths; non-forwarded arguments (`Base<string>`) keep their precision.
            : [ eraseOwnTypeParameterReferences(
                tsInstance,
                heritageTypeToTypeReference(tsInstance, requiredBase),
                declaration.typeParameters
            ) ]
    )
}

// Replace every bare reference to one of `typeParameters` inside `typeNode` with
// `any`. Used to keep the mixin's own type parameters out of type positions that
// cannot bind them (see createRuntimeMixinClassType).
function eraseOwnTypeParameterReferences(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    typeParameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined
): ts.TypeNode {
    if (typeParameters === undefined || typeParameters.length === 0) {
        return typeNode
    }

    const names = new Set(typeParameters.map((typeParameter) => typeParameter.name.text))

    return rewriteTypeReferences(tsInstance, typeNode, (name) =>
        names.has(name) ? tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword) : undefined)
}

export function interfaceHeritageClauses(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.HeritageClause[] | undefined {
    const requiredBase = requiredBaseType(tsInstance, declaration)
    const types        = [
        ...(requiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, requiredBase) ]),
        ...reduceTransitiveMixinHeritageTypes(tsInstance, context, implementsTypes(tsInstance, declaration))
    ]

    if (types.length === 0) {
        return undefined
    }

    return [ tsInstance.factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, types) ]
}

export function exportModifiersOf(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.Modifier[] | undefined {
    if (!hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword) ||
        hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)
    ) {
        return undefined
    }

    return [ tsInstance.factory.createToken(tsInstance.SyntaxKind.ExportKeyword) ]
}

// Factory base parameter: the INSTANCE side (`AnyConstructor`, or
// `AnyConstructor<Req & Dep1<...>>`) intersected with the STATIC sides of the required base
// and the dependencies (`& ClassStatics<typeof Req> & Omit<ClassStatics<typeof Dep>, "mix">`),
// mirroring the source-view `$base` cast. The instance side gives the body typed
// `super.<member>` / `this.<member>` access; the static side gives a `static` body typed
// `super.<baseStatic>` access AND turns on the checker's static-side extends check (TS2417) —
// both exactly as source view always had them. A dependency's framework `mix` is excluded for
// the same reason as in the source-view cast: the mixin's own value provides its own `.mix`.
// The static side uses `typeof <value>`, so statics never thread the mixin's type parameters
// (a class's static side cannot reference them anyway — TS2302) — a generic required base
// contributes its raw uninstantiated static side.
function createBaseParameter(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ParameterDeclaration {
    const factory            = tsInstance.factory
    const requiredBase       = requiredBaseType(tsInstance, declaration)
    const dependencyHeritage = localMixinHeritageTypes(tsInstance, declaration, context)

    const dependencyTypes = [
        ...(requiredBase === undefined
            ? []
            : [ heritageTypeToTypeReference(tsInstance, requiredBase) ]),
        ...dependencyHeritage.map((heritageType) => heritageTypeToTypeReference(tsInstance, heritageType))
    ]

    const baseInstanceType =
        dependencyTypes.length === 0 ? undefined :
        dependencyTypes.length === 1 ? dependencyTypes[0] :
            factory.createIntersectionTypeNode(dependencyTypes)

    const constructorType = factory.createTypeReferenceNode(
        anyConstructorName,
        baseInstanceType === undefined ? undefined : [ baseInstanceType ]
    )

    const staticsTypes = baseStaticsTypes(tsInstance, declaration, context)

    return factory.createParameterDeclaration(
        undefined,
        undefined,
        "base",
        undefined,
        staticsTypes.length === 0
            ? constructorType
            : factory.createIntersectionTypeNode([ constructorType, ...staticsTypes ])
    )
}

// The STATIC sides the factory's base parameter carries — the required base's statics plus
// each dependency's — shared verbatim by the factory's RETURN annotation (the runtime class
// inherits exactly these through `extends base`, so the annotation must re-state them or the
// mixin value would lose the inherited statics).
function baseStaticsTypes(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    // Keys to EXCLUDE from the inherited statics — the class's own static names, when the
    // caller models class-semantics SHADOWING (the return annotation). The base parameter
    // passes none: inside the factory `super.<baseStatic>` must keep seeing the base's own.
    shadowedNames: readonly string[] = []
): ts.TypeNode[] {
    const factory            = tsInstance.factory
    const requiredBase       = requiredBaseType(tsInstance, declaration)
    const dependencyHeritage = localMixinHeritageTypes(tsInstance, declaration, context)
    // Built FRESH per use site — a type node cannot appear in two tree positions.
    const shadowedLiterals = (): ts.TypeNode[] => shadowedNames.map((name) => {
        return factory.createLiteralTypeNode(factory.createStringLiteral(name))
    })

    return [
        ...(requiredBase === undefined
            ? []
            : [ wrapInOmit(
                tsInstance,
                factory.createTypeReferenceNode(classStaticsName, [
                    factory.createTypeQueryNode(expressionToEntityName(tsInstance, requiredBase.expression))
                ]),
                shadowedLiterals()
            ) ]),
        // A dependency's statics also drop the framework marker symbols (`keyof
        // RuntimeMixinClass`): the class inside the factory inherits its static side from this
        // parameter type, and DECLARATION emit expands that static side structurally — a
        // symbol-keyed marker there needs the runtime module's `factory`/`requirements`/`base`
        // names, which the user's file cannot name (TS4023/TS4025 on the exported factory).
        ...localMixinRefs(tsInstance, context, dependencyHeritage)
            .filter((ref) => ref.localValueName !== undefined)
            .map((ref) => factory.createTypeReferenceNode("Omit", [
                factory.createTypeReferenceNode(classStaticsName, [
                    factory.createTypeQueryNode(dottedNameToEntityName(tsInstance, ref.localValueName as string))
                ]),
                factory.createUnionTypeNode([
                    factory.createLiteralTypeNode(factory.createStringLiteral("mix")),
                    factory.createTypeOperatorNode(
                        tsInstance.SyntaxKind.KeyOfKeyword,
                        factory.createTypeReferenceNode(runtimeMixinClassName, undefined)
                    ),
                    ...shadowedLiterals()
                ])
            ]))
    ]
}

// `Omit<type, k1 | k2 | …>`, or the type untouched when there is nothing to omit.
function wrapInOmit(
    tsInstance: TypeScript,
    type: ts.TypeNode,
    keys: readonly ts.TypeNode[]
): ts.TypeNode {
    if (keys.length === 0) {
        return type
    }

    const factory = tsInstance.factory

    return factory.createTypeReferenceNode("Omit", [
        type,
        keys.length === 1 ? keys[0] : factory.createUnionTypeNode([ ...keys ])
    ])
}
