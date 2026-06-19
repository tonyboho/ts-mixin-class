import type * as ts from "typescript"
import { rewritePublicOnlyUndefinedInitializers } from "./construction-initializers.js"
import {
    buildInterfaceMembers,
    constructionProtocolInitializeSignature,
    declaresInstanceInitialize,
    interfaceDeclarationRange
} from "./interface-members.js"
import {
    anyConstructorName,
    classStaticsName,
    consumerBaseSuffix,
    defineMixinClassName,
    extendsClause,
    generatedName,
    implementsTypes,
    isNamedClassElement,
    mixinClassValueName,
    mixinFactoryName,
    requiredBaseType,
    runtimeMixinClassName,
    type FileMixinContext,
    type MixinDeclarationDiagnostic,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    cloneExpressionWithTypeArguments,
    consumerHeritageClauses,
    createSourceViewConsumerBaseHeadType,
    heritageTypeToTypeReference,
    mixinValueIdentifier,
    MixinTransformError
} from "./expand-util.js"
import {
    createMixinApplyType,
    createSourceViewMixinApplyType,
    hasManualMixinApplySyntax
} from "./mixin-apply-type.js"
import {
    collectMixinClassDiagnostics,
    isSupportedMixinClassMember
} from "./mixin-diagnostics.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import { reduceTransitiveMixinHeritageTypes } from "./transitive-heritage-workaround.js"
import { linearizeDependencies } from "./linearization.js"
import {
    createConstructionMembers,
    createMixinConstructionNewType,
    isConstructionBaseOptIn,
    positionConstructionConfigAlias
} from "./construction-config.js"
import { buildImportedNameMap } from "./context.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import {
    cloneNode,
    deepCloneNode,
    generatedTextRange,
    hasModifier,
    preserveGeneratedDeclarationRange,
    preserveSourceViewGeneratedClassLikeRange,
    preserveTextRange
} from "./util.js"
import type { TypeScript } from "./util.js"

// ---------------------------------------------------------------------------
// Mixin class transformation
//
// A mixin class expands into three declarations:
//
//     interface X<T> { ...instance member signatures... }
//     const __X$mixin = <T>(base: AnyConstructor) => class extends base { ...body... }
//     const X = __X$mixin(Object) as unknown as
//         (new <T>(...args: any[]) => X<T>) & ClassStatics<ReturnType<typeof __X$mixin>>

export function expandMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    ref: ResolvedMixinRef,
    context: FileMixinContext,
    options: TransformOptions
): ts.Statement[] {
    const factory     = tsInstance.factory
    const declaration = ref.declaration

    if (declaration === undefined) {
        throw new Error(`Mixin class ${ref.className} has no declaration in the transformed file`)
    }

    const defaultExport          = hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)
    const exportModifiers        = exportModifiersOf(tsInstance, declaration)
    const factoryExportModifiers = hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword)
        ? [ factory.createToken(tsInstance.SyntaxKind.ExportKeyword) ]
        : undefined
    const diagnostics            = collectMixinClassDiagnostics(tsInstance, sourceFile, declaration)
    const diagnosticAliases      = createMixinDeclarationDiagnosticAliases(
        tsInstance,
        ref.className,
        diagnostics,
        declaration
    )

    if (options.sourceView) {
        return [
            ...diagnosticAliases,
            ...expandSourceViewMixinClass(tsInstance, sourceFile, declaration, context, options)
        ]
    }

    // Emit-only: the source-view path above recomputes its own heritage/required
    // base, so these stay below the early return to avoid wasted work per edit.
    const typeParameters = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined
    const requiredBase   = requiredBaseType(tsInstance, declaration)
    const dependencyRefs = localMixinRefs(context, localMixinHeritageTypes(tsInstance, declaration, context))

    // A mixin that extends the package `Base` is construction-enabled. Generic
    // mixins keep the inline value form and are handled separately, so the
    // construction `new` is only added for the non-generic alias form.
    const facts         = getSourceFileFacts(tsInstance, sourceFile, options)
    const baseImportMap = context.crossFile === undefined
        ? undefined
        : buildImportedNameMap(tsInstance, sourceFile, context.crossFile.resolveModuleFileName, facts)

    // A construction-base mixin that applies (implements) other mixins generates
    // `interface <Mixin> extends Base, Dep, …`. When a dependency overrides `initialize`
    // with its own config the inherited members are not identical (TS2320). If the mixin
    // does not declare its own `initialize` override (which would itself resolve it), inject
    // the `Base.initialize` protocol member so the merge succeeds - mirroring the consumer
    // `$base` interface. (See consumer-expand for the same fix.)
    const needsProtocolInitialize = dependencyRefs.length > 0 &&
        !declaresInstanceInitialize(tsInstance, declaration) &&
        isConstructionBaseOptIn(
            tsInstance, sourceFile, requiredBase, options, facts, new Set(), context.crossFile, baseImportMap
        )
    const interfaceMembers        = needsProtocolInitialize
        ? factory.createNodeArray([
            ...buildInterfaceMembers(tsInstance, sourceFile, declaration),
            constructionProtocolInitializeSignature(tsInstance)
        ])
        : buildInterfaceMembers(tsInstance, sourceFile, declaration)

    const constructionNew = typeParameters !== undefined
        ? undefined
        : createMixinConstructionNewType(
            tsInstance,
            sourceFile,
            declaration,
            requiredBase,
            constructionDependencyRefs(context, dependencyRefs),
            options,
            facts,
            context.crossFile,
            baseImportMap
        )

    const interfaceDeclaration = preserveTextRange(tsInstance, factory.createInterfaceDeclaration(
        exportModifiers,
        ref.className,
        typeParameters,
        interfaceHeritageClauses(tsInstance, declaration, context),
        interfaceMembers
    ), interfaceDeclarationRange(declaration, interfaceMembers))

    const factoryStatement = preserveTextRange(tsInstance, factory.createVariableStatement(
        factoryExportModifiers,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(
                ref.localFactoryName,
                undefined,
                undefined,
                createMixinFactoryExpression(tsInstance, declaration, typeParameters, context, options)
            )
        ], tsInstance.NodeFlags.Const)
    ), generatedTextRange(sourceFile, declaration.end))

    const valueStatement = preserveTextRange(tsInstance, factory.createVariableStatement(
        exportModifiers,
        factory.createVariableDeclarationList([
            factory.createVariableDeclaration(
                ref.className,
                undefined,
                undefined,
                factory.createAsExpression(
                    factory.createAsExpression(
                        factory.createCallExpression(
                            factory.createIdentifier(defineMixinClassName),
                            undefined,
                            [
                                factory.createStringLiteral(ref.className),
                                asMixinFactory(tsInstance, factory.createIdentifier(ref.localFactoryName)),
                                factory.createArrayLiteralExpression(
                                    dependencyRefs.map((dependencyRef) => {
                                        return mixinValueIdentifier(tsInstance, dependencyRef)
                                    })
                                ),
                                ...(requiredBase === undefined
                                    ? []
                                    : [ cloneNode(tsInstance, requiredBase.expression) ])
                            ]
                        ),
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    ),
                    createMixinValueCastType(tsInstance, declaration, ref, typeParameters, constructionNew?.newType)
                )
            )
        ], tsInstance.NodeFlags.Const)
    ), generatedTextRange(sourceFile, declaration.end))

    const defaultExportStatement = defaultExport
        ? [ preserveTextRange(tsInstance, factory.createExportAssignment(
            undefined,
            undefined,
            factory.createIdentifier(ref.className)
        ), generatedTextRange(sourceFile, declaration.end)) ]
        : []

    const configAliasStatement = constructionNew === undefined
        ? []
        : [ positionConstructionConfigAlias(
            tsInstance,
            constructionNew.configAlias,
            generatedTextRange(sourceFile, declaration.end),
            declaration
        ) ]

    return [
        interfaceDeclaration,
        ...diagnosticAliases,
        factoryStatement,
        valueStatement,
        ...defaultExportStatement,
        ...configAliasStatement
    ]
}

function createMixinDeclarationDiagnosticAliases(
    tsInstance: TypeScript,
    className: string,
    diagnostics: MixinDeclarationDiagnostic[],
    original: ts.ClassDeclaration
): ts.TypeAliasDeclaration[] {
    const factory = tsInstance.factory

    return diagnostics.map((diagnostic, index) => {
        return preserveGeneratedDeclarationRange(tsInstance, factory.createTypeAliasDeclaration(
            undefined,
            generatedName(className, `$mixinDeclarationError${index}`),
            [ factory.createTypeParameterDeclaration(
                undefined,
                "__mixinDeclarationError",
                factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword),
                factory.createLiteralTypeNode(factory.createStringLiteral(diagnostic.message))
            ) ],
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
        ), diagnostic.node, original)
    })
}

// The construction config must reflect the mixin's whole applied chain: a mixin
// that implements another mixin (which implements a third, ...) gets every
// public config field in that chain. So config collection runs over the
// *linearized* dependencies, not just the direct `implements` refs that drive
// the runtime registration and interface heritage. Falls back to the direct refs
// if linearization fails (a dependency cycle is diagnosed elsewhere). The
// consumer path already linearizes; this keeps the mixin path consistent.
function constructionDependencyRefs(
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

function expandSourceViewMixinClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions
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
        const metadataExtendsClause = preserveTextRange(tsInstance, factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            preserveTextRange(
                tsInstance,
                createSourceViewMixinMetadataBase(tsInstance, sourceFile, declaration, undefined, []),
                generatedHeritageRange
            )
        ]), generatedHeritageRange)

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
            rewritePublicOnlyUndefinedInitializers(tsInstance, declaration.members, options)
        ) ]
    }

    const baseName            = generatedName(declaration.name.text, consumerBaseSuffix)
    const cloneTypeParameters = () => declaration.typeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter))
    const dependencyRefs      = localMixinRefs(context, dependencyHeritage)
    const facts               = getSourceFileFacts(tsInstance, sourceFile, options)
    const baseImportMap       = context.crossFile === undefined
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
    const needsProtocolInitialize = dependencyRefs.length > 0 &&
        isConstructionBaseOptIn(
            tsInstance, sourceFile, requiredBase, options, facts, new Set(), context.crossFile, baseImportMap
        )

    const baseInterface = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createInterfaceDeclaration(
        undefined,
        baseName,
        cloneTypeParameters(),
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                ...(requiredBase === undefined ? [] : [ cloneExpressionWithTypeArguments(tsInstance, requiredBase) ]),
                ...reducedDependencyHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
            ]
        ) ],
        needsProtocolInitialize ? [ constructionProtocolInitializeSignature(tsInstance) ] : []
    ), declaration)

    const baseClass = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        cloneTypeParameters(),
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            createSourceViewMixinMetadataBase(tsInstance, sourceFile, declaration, requiredBase, dependencyRefs)
        ]) ],
        []
    ), declaration)

    // A mixin that extends the package `Base` is a construction base, but in
    // source view it keeps a real class body that merely inherits `Base.new`
    // (returning `Base`). Generate its own `static new` overloads so a standalone
    // `MyMixin.new(...)` resolves to the mixin's instance type, mirroring the
    // value-cast construction `new` the emit path prepends.
    const construction        = declaration.typeParameters !== undefined
        ? { members: [] as ts.ClassElement[], configAlias: undefined }
        : createConstructionMembers(
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
    const updatedMembers      = rewritePublicOnlyUndefinedInitializers(tsInstance, declaration.members, options)
    const mixinMembers        = constructionMembers.length === 0
        ? updatedMembers
        : preserveTextRange(tsInstance, factory.createNodeArray([ ...updatedMembers, ...constructionMembers ]), updatedMembers)

    const updatedDeclaration = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(tsInstance, declaration, baseName, generatedHeritageRange, generatedHeritageTypeRange),
        mixinMembers
    )

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

    return [ baseInterface, baseClass, updatedDeclaration, ...configAliasStatement ]
}

// Source-view mixin class base: a cast that adds RuntimeMixinClass metadata
// (factory/requirements/base symbols) and required-base/dependency statics, so
// typeof MixinClass matches the runtime value.
function createSourceViewMixinMetadataBase(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    requiredBase: ts.ExpressionWithTypeArguments | undefined,
    dependencyRefs: ResolvedMixinRef[]
): ts.ExpressionWithTypeArguments {
    const factory = tsInstance.factory

    const headType              = requiredBase === undefined
        ? factory.createTypeReferenceNode(anyConstructorName, undefined)
        : createSourceViewConsumerBaseHeadType(tsInstance, requiredBase, undefined, undefined)
    const manualMixinApplyTypes = hasManualMixinApplySyntax(sourceFile)
        ? [ createSourceViewMixinApplyType(
            tsInstance,
            declaration,
            declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined
        ) ]
        : []
    const castType              = factory.createIntersectionTypeNode([
        headType,
        ...dependencyRefs
            .filter((ref) => ref.localValueName !== undefined)
            .map((ref) => {
                // Exclude the dependency's own framework `mix` from the inherited statics.
                // `.mix(base)` must resolve to THIS mixin's `mix` (which returns this mixin's
                // instance shape); without the omit a dependency's `mix` (returning the
                // dependency's narrower instance) is intersected before it and wins overload
                // resolution, dropping this mixin's own members from `X.mix(Base)` in source
                // view. The dependency's *user* statics are still inherited.
                return factory.createTypeReferenceNode("Omit", [
                    factory.createTypeReferenceNode(classStaticsName, [
                        factory.createTypeQueryNode(factory.createIdentifier(ref.localValueName as string))
                    ]),
                    factory.createLiteralTypeNode(factory.createStringLiteral("mix"))
                ])
            }),
        ...manualMixinApplyTypes,
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

function createMixinFactoryExpression(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    typeParameters: ts.TypeParameterDeclaration[] | undefined,
    context: FileMixinContext,
    options: TransformOptions
): ts.FunctionExpression {
    const factory = tsInstance.factory

    return factory.createFunctionExpression(
        undefined,
        undefined,
        undefined,
        typeParameters,
        [ createBaseParameter(tsInstance, declaration, context) ],
        undefined,
        factory.createBlock([
            factory.createReturnStatement(
                // Pin the synthetic class expression's range to the mixin's source name.
                // TS2420 ("incorrectly implements") on an anonymous class is reported at
                // the `class` keyword; pinning the expression makes the emit source map
                // place it on the mixin's declaration line, where the IDE / source-view
                // path also reports TS2420 — without it the reprinted class keyword maps
                // to whatever source-map entry happens to precede it (the class body's
                // closing brace), drifting the diagnostic onto the wrong line.
                preserveTextRange(
                    tsInstance,
                    factory.createClassExpression(
                        undefined,
                        undefined,
                        undefined,
                        mixinFactoryHeritageClauses(tsInstance, declaration),
                        mixinRuntimeMembers(tsInstance, declaration, options)
                    ),
                    declaration.name ?? declaration
                )
            )
        ], true)
    )
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
    declaration: ts.ClassDeclaration,
    options: TransformOptions
): ts.NodeArray<ts.ClassElement> {
    const members = tsInstance.factory.createNodeArray(declaration.members.filter((member) => {
        if (tsInstance.isConstructorDeclaration(member) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.AbstractKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.ProtectedKeyword) ||
            isNamedClassElement(member) && tsInstance.isPrivateIdentifier(member.name)
        ) {
            return false
        }

        return isSupportedMixinClassMember(tsInstance, member)
    }))

    return rewritePublicOnlyUndefinedInitializers(tsInstance, members, options)
}

function asMixinFactory(tsInstance: TypeScript, expression: ts.Expression): ts.Expression {
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
function createMixinValueCastType(
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
        return factory.createIntersectionTypeNode([
            factory.createParenthesizedType(factory.createConstructorTypeNode(
                undefined,
                typeParameters,
                [ factory.createParameterDeclaration(
                    undefined,
                    factory.createToken(tsInstance.SyntaxKind.DotDotDotToken),
                    "args",
                    undefined,
                    factory.createArrayTypeNode(factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword))
                ) ],
                instanceType
            )),
            factory.createTypeReferenceNode(classStaticsName, [ factoryReturnType ]),
            createMixinApplyType(tsInstance, declaration, typeParameters, instanceType, factoryReturnType),
            createRuntimeMixinClassType(tsInstance, declaration)
        ])
    }

    const requiredBase = requiredBaseType(tsInstance, declaration)

    return factory.createIntersectionTypeNode([
        // The mixin's own construction `new` comes first so it wins overload
        // resolution over the `Base.new` inherited via MixinClassValue.
        ...(constructionNewType === undefined ? [] : [ constructionNewType ]),
        factory.createTypeReferenceNode(mixinClassValueName, [
            instanceType,
            factory.createTypeQueryNode(factory.createIdentifier(ref.localFactoryName)),
            ...(requiredBase === undefined ? [] : [ heritageTypeToTypeReference(tsInstance, requiredBase) ])
        ]),
        createRuntimeMixinClassType(tsInstance, declaration)
    ])
}

function createRuntimeMixinClassType(
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

    const names  = new Set(typeParameters.map((typeParameter) => typeParameter.name.text))
    const result = tsInstance.transform(typeNode, [
        (context) => {
            const visit: ts.Visitor = (node) => {
                if (tsInstance.isTypeReferenceNode(node) &&
                    tsInstance.isIdentifier(node.typeName) &&
                    node.typeArguments === undefined &&
                    names.has(node.typeName.text)
                ) {
                    return context.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
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

function interfaceHeritageClauses(
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

function exportModifiersOf(
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

// Factory base parameter: AnyConstructor, or AnyConstructor<Dep1<...> & Dep2<...>>
// for a mixin with dependencies. This gives the body typed super access.
function createBaseParameter(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext
): ts.ParameterDeclaration {
    const factory      = tsInstance.factory
    const requiredBase = requiredBaseType(tsInstance, declaration)

    const dependencyTypes = [
        ...(requiredBase === undefined
            ? []
            : [ heritageTypeToTypeReference(tsInstance, requiredBase) ]),
        ...implementsTypes(tsInstance, declaration)
            .filter((heritageType) => {
                return tsInstance.isIdentifier(heritageType.expression) &&
                    context.byLocalName.has(heritageType.expression.text)
            })
            .map((heritageType) => heritageTypeToTypeReference(tsInstance, heritageType))
    ]

    const baseInstanceType =
        dependencyTypes.length === 0 ? undefined :
        dependencyTypes.length === 1 ? dependencyTypes[0] :
            factory.createIntersectionTypeNode(dependencyTypes)

    return factory.createParameterDeclaration(
        undefined,
        undefined,
        "base",
        undefined,
        factory.createTypeReferenceNode(
            anyConstructorName,
            baseInstanceType === undefined ? undefined : [ baseInstanceType ]
        )
    )
}
