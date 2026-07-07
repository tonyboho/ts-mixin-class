import type * as ts from "typescript"
import { fillMissedInitializers } from "./construction-initializers.js"
import { addSyntheticSuperCallToConstructors } from "./consumer-constructors.js"
import {
    constructionProtocolInitializeSignature
} from "./interface-members.js"
import {
    type FileMixinContext,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    anyConstructorLocalName,
    applyLegacyClassDecoratorsLocalName,
    classStaticsLocalName,
    consumerBaseSuffix,
    generatedName
} from "./naming.js"
import { extendsClause, requiredBaseType } from "./heritage.js"
import { cloneExpressionWithTypeArguments, MixinTransformError } from "./expand-util.js"
import { dottedNameToEntityName } from "./entity-name.js"
import {
    appendSourceViewValidationTypeParameters
} from "./consumer-diagnostics.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import {
    consumerHeritageClauses,
    createSourceViewConsumerBaseHeadType
} from "./consumer-base-heritage.js"
import { navigableConsumerBaseClassHeritage } from "./consumer-navigable-heritage.js"
import { reduceTransitiveMixinHeritageTypes } from "./transitive-heritage-workaround.js"
import { linearizeDependencies } from "./linearization.js"
import {
    createConstructionMembers,
    positionConstructionConfigAlias
} from "./construction-config.js"
import { isConstructionBaseOptIn } from "./construction-chain.js"
import { buildImportedNameMap } from "./import-map.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import { userClassDecorators } from "./decorators.js"
import { cloneNode, deepCloneNode } from "./util.js"
import { generatedTextRange, preserveSourceViewGeneratedClassLikeRange, preserveTextRange } from "./text-range.js"
import type { TypeScript } from "./util.js"
import { createRuntimeMixinClassType } from "./mixin-factory.js"

// The SOURCE-VIEW plane of a mixin's expansion: position-preserving, serves tsserver.
// The mixin stays a real class; its heritage is rewritten onto the navigable single-source
// cast (or the `$base` metadata pair when the heritage is not well-typed), and the class
// carries the RuntimeMixinClass metadata + decorate callback. The emit-plane builders live
// in `mixin-factory.ts`; the orchestrator in `mixin-expand.ts`.

// The construction config must reflect the mixin's whole applied chain: a mixin
// that implements another mixin (which implements a third, ...) gets every
// public config field in that chain. So config collection runs over the
// *linearized* dependencies, not just the direct `implements` refs that drive
// the runtime registration and interface heritage. Falls back to the direct refs
// if linearization fails (a dependency cycle is diagnosed elsewhere). The
// consumer path already linearizes; this keeps the mixin path consistent.
export function constructionDependencyRefs(
    context: FileMixinContext,
    dependencyRefs: ResolvedMixinRef[]
): ResolvedMixinRef[] {
    if (dependencyRefs.length === 0) {
        return dependencyRefs
    }

    try {
        return linearizeDependencies(dependencyRefs.map((ref) => ref.key), context)
    } catch {
        return dependencyRefs
    }
}

export function expandSourceViewMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions,
    heritageWellTyped: boolean
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin class must have a name")
    }

    const requiredBase              = requiredBaseType(tsInstance, declaration)
    const dependencyHeritage        = localMixinHeritageTypes(tsInstance, declaration, context)
    const reducedDependencyHeritage = reduceTransitiveMixinHeritageTypes(tsInstance, context, dependencyHeritage)
    // The generated `extends __X$base` replaces the mixin's own `extends Base`,
    // so in source view its range must span the original `extends` clause. A
    // narrow range leaves the base identifier in a sibling gap, which makes
    // tsserver fail token lookup ("Identifier in trivia") for members of the
    // mixin. Matches the consumer path; `implements` clauses are kept as-is.
    const generatedHeritageRange = extendsClause(tsInstance, declaration) ??
        generatedTextRange(
            sourceFile,
            declaration.heritageClauses?.pos ?? declaration.typeParameters?.end ?? declaration.name.end
        )
    // Pin the generated `extends __X$base` reference onto the source base type so
    // hovering the original base name (`RequiredBase` in `extends RequiredBase`)
    // highlights just that identifier instead of the whole heritage clause.
    // Matches how the consumer path passes `generatedHeritageTypeRange`.
    const generatedHeritageTypeRange = extendsClause(tsInstance, declaration)?.types[0] ?? generatedHeritageRange

    if (dependencyHeritage.length === 0 && requiredBase === undefined) {
        const metadataExtendsClause = preserveTextRange(
            tsInstance,
            factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
                preserveTextRange(
                    tsInstance,
                    createSourceViewMixinMetadataBase(tsInstance, declaration, undefined, []),
                    generatedHeritageRange
                )
            ]),
            generatedHeritageRange
        )

        return [ factory.updateClassDeclaration(
            declaration,
            declaration.modifiers,
            declaration.name,
            declaration.typeParameters,
            preserveTextRange(
                tsInstance,
                factory.createNodeArray([ metadataExtendsClause, ...(declaration.heritageClauses ?? []) ]),
                declaration.heritageClauses ?? generatedHeritageRange
            ),
            fillMissedInitializers(tsInstance, addSyntheticSuperCallToConstructors(tsInstance, sourceFile, declaration.members, true), options)
        ) ]
    }

    const baseName = generatedName(declaration.name.text, consumerBaseSuffix)
    // A mixin's own linearization conflict is now a NATIVE diagnostic (pushed in expandMixinClass
    // before the source-view/emit split), so `__X$base` carries no never-constrained validation —
    // only the mixin's own type parameters (deep-cloned so they carry no shared source positions).
    const baseTypeParameters = () => appendSourceViewValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        []
    )
    const dependencyRefs     = localMixinRefs(tsInstance, context, dependencyHeritage)
    const facts              = getSourceFileFacts(tsInstance, sourceFile, options)
    const baseImportMap      = context.crossFile === undefined
        ? undefined
        : buildImportedNameMap(tsInstance, sourceFile, context.crossFile.resolveModuleFileName, facts)

    // A construction-base mixin applying (implementing) other mixins generates
    // `interface __X$base extends Base, Dep, …`. If a dependency overrides `initialize`
    // with its own config the inherited members are not identical (TS2320), so inject the
    // `Base.initialize` protocol member - the same fix the consumer `$base` interface uses.
    // Unlike the emit structural `interface X` (whose body carries the class's own
    // `initialize` override, which would itself resolve the conflict), this `__X$base` NEVER
    // contains the class members - the mixin's own override lives on the real class that
    // `extends __X$base` - so the member is needed even when the class declares `initialize`.
    // The member is synthetic; in source view it normalizes onto the off-screen `$base` range
    // and the alignment pass clears its `Synthesized` flag (`MethodSignature` is a navigable
    // kind), so navigation does not crash.
    // A construction (package-`Base`-deriving) mixin must refuse a direct `new` (construction goes
    // through the static `.new`). When the mixin declares NO constructor, the brand rides on the
    // `$base` cast the class extends, so the real class inherits the poisoned construct. When it
    // DOES declare its own constructor, that constructor's signature — not `$base`'s — governs an
    // external `new`, and the only way to poison it in source view is to inject a parameter, which
    // shifts the position-preserved constructor body and breaks navigation. So source view leaves
    // the with-constructor case unbranded (its `super()` stays valid); the EMIT plane still bans it
    // through the value cast, so a build (`tsc`) catches the stray `new` regardless.
    const isConstructionMixin = isConstructionBaseOptIn(
        tsInstance,
        sourceFile,
        requiredBase,
        options,
        facts,
        new Set(),
        context.crossFile,
        baseImportMap
    )
    const hasOwnConstructor   = declaration.members.some((member) => tsInstance.isConstructorDeclaration(member))
    // A mixin with its OWN `static new` owns construction (the generated factory is suppressed —
    // `hasStaticNew`), so the direct-`new` brand is lifted here too: the emit value cast falls
    // back to the permissive `MixinClassValue` form in that case, and the planes must agree.
    const hasOwnStaticNew         = facts.classesByDeclaration.get(declaration)?.hasStaticNew === true
    const brandConstructionBase   = isConstructionMixin && !hasOwnConstructor && !hasOwnStaticNew
    const needsProtocolInitialize = dependencyRefs.length > 0 && isConstructionMixin

    // A mixin that extends the package `Base` is a construction base, but in
    // source view it keeps a real class body that merely inherits `Base.new`
    // (returning `Base`). Generate its own `static new` overloads so a standalone
    // `MyMixin.new(...)` resolves to the mixin's instance type, mirroring the
    // value-cast construction `new` the emit path prepends.
    // Generic mixins included: createConstructionMembers already clones the class's type
    // parameters onto the generated `static new` (the same machinery generic construction
    // CLASSES use — §7.10).
    const construction        = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        requiredBase,
        undefined,
        constructionDependencyRefs(context, dependencyRefs),
        options,
        generatedTextRange(sourceFile, declaration.members.end),
        context.crossFile,
        baseImportMap
    )
    const constructionMembers = construction.members
    const updatedMembers      = fillMissedInitializers(tsInstance, addSyntheticSuperCallToConstructors(tsInstance, sourceFile, declaration.members, true), options)
    const mixinMembers        = constructionMembers.length === 0
        ? updatedMembers
        : preserveTextRange(tsInstance, factory.createNodeArray([ ...updatedMembers, ...constructionMembers ]), updatedMembers)

    // A construction-base mixin gets the same exported `<MixinName>Config` alias as any
    // other construction base; it is a sibling top-level statement (never generic here -
    // generic mixins are excluded from construction `new` above).
    const configAliasStatement = construction.configAlias === undefined
        ? []
        : [ positionConstructionConfigAlias(
            tsInstance,
            construction.configAlias,
            generatedTextRange(sourceFile, declaration.end),
            declaration
        ) ]

    // Navigable fast path for the MIXIN's own heritage: a well-typed mixin with an
    // explicit entity-name required base needs no `__X$base` indirection. The mixin
    // re-extends the real base under the same single-source cast consumers use — the
    // base reference pinned onto the source token, so go-to-definition / references /
    // rename / quickinfo on `extends RequiredBase` reach the real base class — with
    // the required base + dependency instances in the construct signature (an
    // intersection, so no `protocolInitialize` TS2320 mediation is needed) and the
    // mixin's `RuntimeMixinClass<...>` metadata riding as extra statics. A generic
    // mixin threads its type parameters exactly like a generic consumer. Broken
    // heritage (a mixin extending a mixin, a linearization conflict) keeps the pair.
    if (requiredBase !== undefined && heritageWellTyped) {
        const navigableExtends = navigableConsumerBaseClassHeritage(
            tsInstance,
            requiredBase,
            reducedDependencyHeritage,
            dependencyRefs,
            requiredBase,
            declaration.typeParameters,
            isConstructionMixin
                ? { consumerName: declaration.name.text, branded: brandConstructionBase }
                : undefined,
            [ createRuntimeMixinClassType(tsInstance, declaration) ]
        )
        const implementsClause = declaration.heritageClauses?.find((heritageClause) => {
            return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
        })
        const heritageClauses  = preserveTextRange(
            tsInstance,
            factory.createNodeArray(implementsClause === undefined
                ? [ navigableExtends ]
                : [ navigableExtends, implementsClause ]),
            declaration.heritageClauses ?? requiredBase
        )

        return [
            factory.updateClassDeclaration(
                declaration,
                declaration.modifiers,
                declaration.name,
                declaration.typeParameters,
                heritageClauses,
                mixinMembers
            ),
            ...configAliasStatement
        ]
    }

    const baseInterface = preserveSourceViewGeneratedClassLikeRange(
        tsInstance,
        factory.createInterfaceDeclaration(
            undefined,
            baseName,
            baseTypeParameters(),
            [ factory.createHeritageClause(
                tsInstance.SyntaxKind.ExtendsKeyword,
                [
                    ...(requiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, requiredBase) ]),
                    ...reducedDependencyHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
                ]
            ) ],
            needsProtocolInitialize ? [ constructionProtocolInitializeSignature(tsInstance) ] : []
        ),
        declaration
    )

    const baseClass = preserveSourceViewGeneratedClassLikeRange(
        tsInstance,
        factory.createClassDeclaration(
            undefined,
            baseName,
            baseTypeParameters(),
            [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
                createSourceViewMixinMetadataBase(tsInstance, declaration, requiredBase, dependencyRefs, brandConstructionBase)
            ]) ],
            []
        ),
        declaration
    )

    const updatedDeclaration = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(
            tsInstance,
            declaration,
            baseName,
            generatedHeritageRange,
            generatedHeritageTypeRange
        ),
        mixinMembers
    )

    return [ baseInterface, baseClass, updatedDeclaration, ...configAliasStatement ]
}

// Source-view mixin class base: a cast that adds RuntimeMixinClass metadata
// (factory/requirements/base symbols) and required-base/dependency statics, so
// typeof MixinClass matches the runtime value.
function createSourceViewMixinMetadataBase(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    requiredBase: ts.ExpressionWithTypeArguments | undefined,
    dependencyRefs: ResolvedMixinRef[],
    isConstructionMixin = false
): ts.ExpressionWithTypeArguments {
    const factory = tsInstance.factory

    // A construction mixin brands the `$base` head so the real class refuses a direct `new`, in
    // parity with the emit value cast; a base-less / custom-required-base mixin keeps the permissive
    // head, so its direct `new` stays allowed.
    const construction = isConstructionMixin && declaration.name !== undefined
        ? { consumerName: declaration.name.text, branded: true }
        : undefined
    const headType     = requiredBase === undefined
        ? factory.createTypeReferenceNode(anyConstructorLocalName, undefined)
        : createSourceViewConsumerBaseHeadType(tsInstance, requiredBase, undefined, undefined, construction)
    const castType     = factory.createIntersectionTypeNode([
        headType,
        ...dependencyRefs
            .filter((ref) => ref.localValueName !== undefined)
            .map((ref) => {
                // Exclude the dependency's own framework `mix` from the inherited statics.
                // On the source-view plane the mixin value carries NO `mix` of its own
                // (program-local manual `.mix` is banned — TS990012), so an inherited
                // dependency `mix` (returning the DEPENDENCY's narrower instance) would be
                // both a type lie and a hole in the ban. The dependency's *user* statics
                // are still inherited.
                return factory.createTypeReferenceNode("Omit", [
                    factory.createTypeReferenceNode(classStaticsLocalName, [
                        factory.createTypeQueryNode(dottedNameToEntityName(tsInstance, ref.localValueName as string))
                    ]),
                    factory.createLiteralTypeNode(factory.createStringLiteral("mix"))
                ])
            }),
        createRuntimeMixinClassType(tsInstance, declaration)
    ])

    return factory.createExpressionWithTypeArguments(
        factory.createParenthesizedExpression(
            factory.createAsExpression(
                factory.createAsExpression(
                    requiredBase === undefined
                        ? factory.createIdentifier("Object")
                        : cloneNode(tsInstance, requiredBase.expression),
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                ),
                castType
            )
        ),
        undefined
    )
}

// The generated name of the `decorate` callback's parameter — the undecorated canonical class
// handed in by `defineMixinClass`.
const decorateValueParameterName = "__mixinValue"

// The `decorate` CALLBACK for `defineMixinClass` that re-applies USER decorators from the
// `@mixin` class (the class declaration itself is erased into the value cast, so the compiler
// would silently drop them). Runs INSIDE `defineMixinClass`, before metadata attachment, so
// the DECORATED class becomes the mixin's runtime identity — a post-hoc wrap would leave two
// identities (wrapper vs canonical) and break the runtime C3/replay linearization cross-check.
// The decorator MODE picks the shape:
//
// - STANDARD (TC39): `(__mixinValue) => { @dec class X extends (__mixinValue as unknown as
//   AnyConstructor) {} return X }` — a REAL decorated class declaration, so the COMPILER emits
//   the whole machinery (context, `Symbol.metadata`, `addInitializer`, replacement rebinding).
//   The inner class is type-erased (its base is cast to `AnyConstructor`, it lives in the
//   callback's own scope), so it neither merges with the generated `interface X` (no TS2310
//   base-type cycle) nor needs the mixin's type parameters (TS2562 forbids them in base
//   expressions) — the public value cast stays byte-identical. The inner class legally carries
//   the mixin's own name: `context.name` and `X.name` read the real name, and what the
//   callback returns IS the constructor the user holds.
// - LEGACY (`experimentalDecorators`): a plain runtime fold, bottom-up `dec(value) ?? value` —
//   `(__mixinValue) => __applyLegacyClassDecorators__(__mixinValue, [dec1, dec2])` (no extra
//   class layer).
//
// Applied ONCE, to the mixin VALUE — consumers compose through the factory and are not
// re-decorated (the §2.8 consumer parallel). Decorator signatures are type-checked on the
// source-view plane, where the decorators stay on the real class. Returns undefined when the
// class carries no user decorators (the `decorate` argument is omitted entirely).
export function createMixinDecorateCallback(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    ref: ResolvedMixinRef,
    options: TransformOptions
): ts.Expression | undefined {
    const factory    = tsInstance.factory
    const decorators = userClassDecorators(
        tsInstance,
        declaration,
        getSourceFileFacts(tsInstance, sourceFile, options).mixinDecoratorImports,
        options
    )

    if (decorators.length === 0) {
        return undefined
    }

    const valueParameter = factory.createParameterDeclaration(
        undefined,
        undefined,
        decorateValueParameterName
    )

    if (options.experimentalDecorators) {
        return factory.createArrowFunction(
            undefined,
            undefined,
            [ valueParameter ],
            undefined,
            undefined,
            factory.createCallExpression(
                factory.createIdentifier(applyLegacyClassDecoratorsLocalName),
                undefined,
                [
                    factory.createIdentifier(decorateValueParameterName),
                    // The decorator EXPRESSIONS (without `@`), in source order — the array
                    // literal evaluates them top-down exactly as the compiler would; the
                    // runtime fold then applies bottom-up.
                    factory.createArrayLiteralExpression(
                        decorators.map((decorator) => deepCloneNode(tsInstance, decorator.expression))
                    )
                ]
            )
        )
    }

    const decoratedClass = factory.createClassDeclaration(
        decorators.map((decorator) => deepCloneNode(tsInstance, decorator)),
        factory.createIdentifier(ref.className),
        undefined,
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            factory.createExpressionWithTypeArguments(
                factory.createParenthesizedExpression(
                    factory.createAsExpression(
                        factory.createAsExpression(
                            factory.createIdentifier(decorateValueParameterName),
                            factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                        ),
                        factory.createTypeReferenceNode(anyConstructorLocalName, undefined)
                    )
                ),
                undefined
            )
        ]) ],
        []
    )

    return factory.createArrowFunction(
        undefined,
        undefined,
        [ valueParameter ],
        undefined,
        undefined,
        factory.createBlock(
            [
                decoratedClass,
                factory.createReturnStatement(factory.createIdentifier(ref.className))
            ],
            true
        )
    )
}
