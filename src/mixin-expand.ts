import type * as ts from "typescript"
import { fillMissedInitializers } from "./construction-initializers.js"
import { addSyntheticSuperCallToConstructors } from "./consumer-constructors.js"
import {
    buildInterfaceMembers,
    constructionProtocolInitializeSignature,
    declaresInstanceInitialize,
    interfaceDeclarationRange
} from "./interface-members.js"
import {
    nativeDiagnosticOn,
    anyConstructorName,
    applyLegacyClassDecoratorsLocalName,
    classStaticsName,
    consumerBaseSuffix,
    defineMixinClassLocalName,
    DependencyLinearizationError,
    extendsClause,
    generatedName,
    implementsTypes,
    isNamedClassElement,
    constructionMixinClassValueName,
    mixinClassValueName,
    mixinDiagnosticCode,
    mixinFactoryName,
    mixinRuntimeClassSuffix,
    registryKey,
    requiredBaseType,
    runtimeMixinClassName,
    type FileMixinContext,
    type NativeMixinDiagnostic,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    brandedConstructSignatureType,
    cloneExpressionWithTypeArguments,
    consumerHeritageClauses,
    createLinearizationPlanLiteral,
    createSourceViewConsumerBaseHeadType,
    dottedNameToEntityName,
    expressionToEntityName,
    heritageTypeToTypeReference,
    linearizationMode,
    MixinTransformError,
    mixinValueIdentifier,
    rewriteTypeReferences
} from "./expand-util.js"
import {
    appendSourceViewValidationTypeParameters,
    linearizationDiagnosticMessage,
    pushLinearizationConflictDiagnostic
} from "./consumer-diagnostics.js"
import { createMixinApplyType } from "./mixin-apply-type.js"
import {
    collectMixinClassDiagnostics,
    isSupportedMixinClassMember
} from "./mixin-diagnostics.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import { navigableConsumerBaseClassHeritage } from "./consumer-base-heritage.js"
import { reduceTransitiveMixinHeritageTypes } from "./transitive-heritage-workaround.js"
import { deriveLinearizationPlan, linearizeDependencies, type LinearizationPlanSlice } from "./linearization.js"
import {
    createConstructionMembers,
    createMixinConstructionNewType,
    isConstructionBaseOptIn,
    positionConstructionConfigAlias
} from "./construction-config.js"
import { buildImportedNameMap } from "./context.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import { userClassDecorators } from "./decorators.js"
import {
    cloneNode,
    deepCloneNode,
    generatedTextRange,
    hasModifier,
    preserveSourceViewGeneratedClassLikeRange,
    preserveTextRange,
    stripVarianceAnnotations
} from "./util.js"
import type { TypeScript } from "./util.js"

// ---------------------------------------------------------------------------
// Mixin class transformation
//
// A mixin class expands into three declarations:
//
//     interface X<T> { ...instance member signatures... }
//     const __X$mixin = function <T>(base: AnyConstructor) { class __X$class extends base { ...body... } return __X$class }
//     const X = __X$mixin(Object) as unknown as
//         (new <T>(...args: any[]) => X<T>) & ClassStatics<ReturnType<typeof __X$mixin>>

// A native diagnostic when a `@mixin` class `extends` a target that resolves to another
// registered mixin (same-file or imported). Returns undefined when the base is absent, is not a
// plain identifier, or does not resolve to a mixin (a non-mixin required base is legitimate).
function mixinExtendsMixinDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    ref: ResolvedMixinRef,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions
): NativeMixinDiagnostic | undefined {
    const base = requiredBaseType(tsInstance, declaration)

    if (base === undefined || !tsInstance.isIdentifier(base.expression)) {
        return undefined
    }

    const baseName = base.expression.text

    if (!baseNameResolvesToMixin(tsInstance, sourceFile, baseName, context, options)) {
        return undefined
    }

    return nativeDiagnosticOn(
        tsInstance, sourceFile, base.expression,
        mixinDiagnosticCode.MixinExtendsMixin,
        `Invalid mixin class declaration. Mixin class ${ref.className} cannot extend another mixin class (${baseName}). ` +
            "A mixin consumes other mixins through `implements` (which builds the runtime chain); " +
            "`extends` on a mixin is reserved for a required, non-mixin base class. " +
            `Fix: write \`class ${ref.className} implements ${baseName}\` to mix ${baseName} in, or extend a non-mixin base class.`
    )
}

// Whether `name`, used as a `@mixin`'s `extends` base in `sourceFile`, resolves to a registered
// mixin — a same-file mixin (registered under the file's own key) or an imported one (resolved
// through the file's import map to its declaring key). Needs the cross-file registry; absent it
// (a single-file in-process transform) nothing is a known mixin.
function baseNameResolvesToMixin(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    name: string,
    context: FileMixinContext,
    options: TransformOptions
): boolean {
    const crossFile = context.crossFile

    if (crossFile === undefined) {
        return false
    }

    if (crossFile.registry.has(registryKey(sourceFile.fileName, name))) {
        return true
    }

    const imported = buildImportedNameMap(
        tsInstance,
        sourceFile,
        crossFile.resolveModuleFileName,
        getSourceFileFacts(tsInstance, sourceFile, options)
    ).get(name)

    return imported !== undefined &&
        crossFile.registry.has(registryKey(imported.resolvedFileName, imported.importedName))
}

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
    // Invalid mixin members/modifiers (abstract / constructor / private / #private / abstract
    // member / missing type annotations / unsupported member): NATIVE diagnostics (one per finding,
    // family code TS990004), drained by `wrapProgramDiagnostics`. Each is spanned on its offending
    // node, pushed before the source-view/emit split so it surfaces identically in both.
    for (const diagnostic of collectMixinClassDiagnostics(tsInstance, sourceFile, declaration)) {
        context.nativeDiagnostics.push(nativeDiagnosticOn(
            tsInstance, sourceFile, diagnostic.node,
            mixinDiagnosticCode.MixinInvalidDeclaration,
            diagnostic.message
        ))
    }

    // A `@mixin` must not `extends` another mixin (that consumes it as a required base, which is
    // reserved for non-mixin bases) — it should `implements` it. This is a NATIVE diagnostic
    // (authored here, drained by `wrapProgramDiagnostics`), so it is pushed once per transform of
    // the file, before the source-view/emit split below so it surfaces identically in both.
    const mixinBaseDiagnostic = mixinExtendsMixinDiagnostic(tsInstance, sourceFile, ref, declaration, context, options)

    if (mixinBaseDiagnostic !== undefined) {
        context.nativeDiagnostics.push(mixinBaseDiagnostic)
    }
    // A mixin whose OWN dependencies cannot be C3-linearized (a conflict with no consumer to force
    // it) is a NATIVE diagnostic (family code TS990007), pushed here before the source-view/emit
    // split so it surfaces identically in both — no `__X$base` validation (source view) or
    // `MixinLinearizationConflict<message>` value-cast intersection (emit) any more. No merge plan
    // is emitted for a conflicting set. Spanned on the first `implements` entry (the conflict's deps).
    const dependencyHeritage    = localMixinHeritageTypes(tsInstance, declaration, context)
    const dependencyRefs        = localMixinRefs(tsInstance, context, dependencyHeritage)
    const linearizationConflict = mixinLinearizationConflict(context, dependencyRefs)

    if (linearizationConflict !== undefined && declaration.name !== undefined) {
        pushLinearizationConflictDiagnostic(
            tsInstance,
            sourceFile,
            context,
            dependencyHeritage[0] ?? declaration.name,
            linearizationDiagnosticMessage(dependencyRefs, context, linearizationConflict)
        )
    }

    if (options.sourceView) {
        return [
            ...expandSourceViewMixinClass(
                tsInstance,
                sourceFile,
                declaration,
                context,
                options,
                // The navigable fast path is for well-typed heritage only; a mixin
                // extending another mixin or carrying a dependency-linearization
                // conflict keeps the `$base` pair (broken code, diagnosed above).
                mixinBaseDiagnostic === undefined && linearizationConflict === undefined
            )
        ]
    }

    // Emit-only: the source-view path above recomputes its own heritage/required
    // base, so these stay below the early return to avoid wasted work per edit.
    const typeParameters = declaration.typeParameters !== undefined ? [ ...declaration.typeParameters ] : undefined
    const requiredBase   = requiredBaseType(tsInstance, declaration)
    // Approach (B): precompute this mixin's requirement linearization as a merge plan the
    // runtime replays instead of running C3. Absent for a dependency-free mixin (no merge)
    // and for a conflicting requirement set (the conflict is reported above) -- the runtime
    // falls back to C3 in those cases.
    const linearizationPlan = linearizationConflict !== undefined || dependencyRefs.length === 0
        ? undefined
        : deriveLinearizationPlan(dependencyRefs.map((dependencyRef) => dependencyRef.key), context)

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

    // Generic and non-generic mixins alike: the generic form gets `"new"<T>(props?:
    // <Mixin>Config<T>): Mixin<T>` (the value cast's generic branch prepends it and swaps the
    // permissive construct for the branded one).
    const constructionNew = createMixinConstructionNewType(
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
                createMixinFactoryExpression(
                    tsInstance,
                    sourceFile,
                    declaration,
                    typeParameters,
                    generatedName(ref.className, mixinRuntimeClassSuffix),
                    context,
                    options
                )
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
                            factory.createIdentifier(defineMixinClassLocalName),
                            undefined,
                            defineMixinClassArguments(
                                tsInstance,
                                ref,
                                dependencyRefs,
                                requiredBase,
                                linearizationPlan,
                                linearizationMode(options),
                                createMixinDecorateCallback(tsInstance, sourceFile, declaration, ref, options)
                            )
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
        factoryStatement,
        valueStatement,
        ...defaultExportStatement,
        ...configAliasStatement
    ]
}

// The `defineMixinClass(name, factory, [deps], requiredBase?, plan?, mode?, decorate?)`
// arguments. The optional slots are positional-trailing, so an absent one before a present one
// is filled with an explicit `undefined` (which re-selects the runtime default); the argument
// list is truncated after the last present slot.
function defineMixinClassArguments(
    tsInstance: TypeScript,
    ref: ResolvedMixinRef,
    dependencyRefs: ResolvedMixinRef[],
    requiredBase: ts.ExpressionWithTypeArguments | undefined,
    linearizationPlan: LinearizationPlanSlice[] | undefined,
    mode: "verify" | "replay" | "c3",
    decorateCallback: ts.Expression | undefined
): ts.Expression[] {
    const factory                                 = tsInstance.factory
    const explicitUndefined                       = (): ts.Expression => factory.createIdentifier("undefined")
    const trailing: (ts.Expression | undefined)[] = [
        requiredBase === undefined ? undefined : cloneNode(tsInstance, requiredBase.expression),
        linearizationPlan === undefined ? undefined : createLinearizationPlanLiteral(tsInstance, linearizationPlan),
        linearizationPlan === undefined ? undefined : factory.createStringLiteral(mode),
        decorateCallback
    ]

    while (trailing.length > 0 && trailing[trailing.length - 1] === undefined) {
        trailing.pop()
    }

    return [
        factory.createStringLiteral(ref.className),
        asMixinFactory(tsInstance, factory.createIdentifier(ref.localFactoryName)),
        factory.createArrayLiteralExpression(
            dependencyRefs.map((dependencyRef) => mixinValueIdentifier(tsInstance, dependencyRef))
        ),
        ...trailing.map((argument) => argument ?? explicitUndefined())
    ]
}

// The mixin's own requirement set cannot be C3-linearized: returns the error (so the caller
// can report it on the mixin) or undefined when the set is empty or consistent.
function mixinLinearizationConflict(
    context: FileMixinContext,
    dependencyRefs: ResolvedMixinRef[]
): DependencyLinearizationError | undefined {
    if (dependencyRefs.length === 0) {
        return undefined
    }

    try {
        linearizeDependencies(dependencyRefs.map((dependencyRef) => dependencyRef.key), context)

        return undefined
    } catch (error) {
        if (error instanceof DependencyLinearizationError) {
            return error
        }

        throw error
    }
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
        const metadataExtendsClause = preserveTextRange(tsInstance, factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            preserveTextRange(
                tsInstance,
                createSourceViewMixinMetadataBase(tsInstance, declaration, undefined, []),
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
        tsInstance, sourceFile, requiredBase, options, facts, new Set(), context.crossFile, baseImportMap
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

    const baseInterface = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createInterfaceDeclaration(
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
    ), declaration)

    const baseClass = preserveSourceViewGeneratedClassLikeRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        baseTypeParameters(),
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            createSourceViewMixinMetadataBase(tsInstance, declaration, requiredBase, dependencyRefs, brandConstructionBase)
        ]) ],
        []
    ), declaration)

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
        ? factory.createTypeReferenceNode(anyConstructorName, undefined)
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
                    factory.createTypeReferenceNode(classStaticsName, [
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
function createMixinDecorateCallback(
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
                        factory.createTypeReferenceNode(anyConstructorName, undefined)
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
        factory.createBlock([
            decoratedClass,
            factory.createReturnStatement(factory.createIdentifier(ref.className))
        ], true)
    )
}

function createMixinFactoryExpression(
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
        factory.createBlock([
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
        ], true)
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

    const names = new Set(typeParameters.map((typeParameter) => typeParameter.name.text))

    return rewriteTypeReferences(tsInstance, typeNode, (name) =>
        names.has(name) ? tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword) : undefined)
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
            : [ wrapInOmit(tsInstance, factory.createTypeReferenceNode(classStaticsName, [
                factory.createTypeQueryNode(expressionToEntityName(tsInstance, requiredBase.expression))
            ]), shadowedLiterals()) ]),
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
