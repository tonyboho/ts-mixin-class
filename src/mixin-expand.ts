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
    anyConstructorName,
    classStaticsName,
    consumerBaseSuffix,
    defineMixinClassName,
    DependencyLinearizationError,
    extendsClause,
    generatedName,
    implementsTypes,
    isNamedClassElement,
    constructionMixinClassValueName,
    mixinClassValueName,
    mixinDiagnosticCode,
    mixinFactoryName,
    mixinLinearizationConflictName,
    registryKey,
    requiredBaseType,
    runtimeMixinClassName,
    type FileMixinContext,
    type NativeMixinDiagnostic,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    cloneExpressionWithTypeArguments,
    consumerHeritageClauses,
    createLinearizationPlanLiteral,
    brandedConstructSignatureType,
    createSourceViewConsumerBaseHeadType,
    heritageTypeToTypeReference,
    linearizationMode,
    mixinValueIdentifier,
    MixinTransformError,
    rewriteTypeReferences
} from "./expand-util.js"
import {
    appendSourceViewValidationTypeParameters,
    createLinearizationDiagnosticValidation,
    linearizationDiagnosticMessage
} from "./consumer-diagnostics.js"
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
import { deriveLinearizationPlan, linearizeDependencies, type LinearizationPlanSlice } from "./linearization.js"
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
    generatedTextRange,
    hasModifier,
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

    const start = base.expression.getStart(sourceFile)

    return {
        fileName : sourceFile.fileName,
        start,
        length   : base.expression.getEnd() - start,
        code     : mixinDiagnosticCode.MixinExtendsMixin,
        category : tsInstance.DiagnosticCategory.Error,
        messageText :
            `Invalid mixin class declaration. Mixin class ${ref.className} cannot extend another mixin class (${baseName}). ` +
            "A mixin consumes other mixins through `implements` (which builds the runtime chain); " +
            "`extends` on a mixin is reserved for a required, non-mixin base class. " +
            `Fix: write \`class ${ref.className} implements ${baseName}\` to mix ${baseName} in, or extend a non-mixin base class.`
    }
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
        const start = diagnostic.node.getStart(sourceFile)

        context.nativeDiagnostics.push({
            fileName    : sourceFile.fileName,
            start,
            length      : diagnostic.node.getEnd() - start,
            code        : mixinDiagnosticCode.MixinInvalidDeclaration,
            category    : tsInstance.DiagnosticCategory.Error,
            messageText : diagnostic.message
        })
    }

    // A `@mixin` must not `extends` another mixin (that consumes it as a required base, which is
    // reserved for non-mixin bases) — it should `implements` it. This is a NATIVE diagnostic
    // (authored here, drained by `wrapProgramDiagnostics`), so it is pushed once per transform of
    // the file, before the source-view/emit split below so it surfaces identically in both.
    const mixinBaseDiagnostic = mixinExtendsMixinDiagnostic(tsInstance, sourceFile, ref, declaration, context, options)

    if (mixinBaseDiagnostic !== undefined) {
        context.nativeDiagnostics.push(mixinBaseDiagnostic)
    }
    // A mixin whose OWN dependencies cannot be C3-linearized (a conflict with no consumer to
    // force it) is reported on the mixin in BOTH paths, via two carriers since emit has no
    // `__X$base`: source view puts a never-constrained validation type parameter on the
    // generated `__X$base` (consumer-style, see expandSourceViewMixinClass); emit intersects
    // `MixinLinearizationConflict<message>` into the value cast (see
    // withMixinLinearizationConflictType). No merge plan is emitted for a conflicting set.
    const dependencyRefs        = localMixinRefs(context, localMixinHeritageTypes(tsInstance, declaration, context))
    const linearizationConflict = mixinLinearizationConflict(context, dependencyRefs)
    const linearizationMessage  = linearizationConflict === undefined
        ? undefined
        : linearizationDiagnosticMessage(dependencyRefs, context, linearizationConflict)

    if (options.sourceView) {
        return [
            ...expandSourceViewMixinClass(tsInstance, sourceFile, declaration, context, options, linearizationMessage)
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
                createMixinFactoryExpression(tsInstance, sourceFile, declaration, typeParameters, context, options)
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
                            defineMixinClassArguments(
                                tsInstance,
                                ref,
                                dependencyRefs,
                                requiredBase,
                                linearizationPlan,
                                linearizationMode(options)
                            )
                        ),
                        factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                    ),
                    withMixinLinearizationConflictType(
                        tsInstance,
                        declaration,
                        createMixinValueCastType(tsInstance, declaration, ref, typeParameters, constructionNew?.newType),
                        linearizationMessage
                    )
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

// The `defineMixinClass(name, factory, [deps], requiredBase?, plan?, mode?)` arguments. The
// plan is trailing, so when a mixin has a plan but no required base the `requiredBase` slot is
// filled with an explicit `undefined` (which re-selects the runtime default `Object`); the
// mode follows the plan.
function defineMixinClassArguments(
    tsInstance: TypeScript,
    ref: ResolvedMixinRef,
    dependencyRefs: ResolvedMixinRef[],
    requiredBase: ts.ExpressionWithTypeArguments | undefined,
    linearizationPlan: LinearizationPlanSlice[] | undefined,
    mode: "verify" | "replay" | "c3"
): ts.Expression[] {
    const factory = tsInstance.factory
    const args    = [
        factory.createStringLiteral(ref.className),
        asMixinFactory(tsInstance, factory.createIdentifier(ref.localFactoryName)),
        factory.createArrayLiteralExpression(
            dependencyRefs.map((dependencyRef) => mixinValueIdentifier(tsInstance, dependencyRef))
        )
    ]

    if (linearizationPlan !== undefined) {
        args.push(requiredBase === undefined
            ? factory.createIdentifier("undefined")
            : cloneNode(tsInstance, requiredBase.expression))
        args.push(createLinearizationPlanLiteral(tsInstance, linearizationPlan))
        args.push(factory.createStringLiteral(mode))
    } else if (requiredBase !== undefined) {
        args.push(cloneNode(tsInstance, requiredBase.expression))
    }

    return args
}

// Emit-mode reporting for a mixin whose own dependencies cannot be C3-linearized: intersect
// `MixinLinearizationConflict<"<message>">` into the value cast so `tsc` reports the message.
// Only for a conflicting set (message present); the normal cast is returned untouched
// otherwise. The message string literal is pinned to the mixin's first `implements` type so
// the emitted diagnostic remaps onto the heritage line, matching where the source-view path
// reports it. (The source-view path reports on `$base` instead, so this is emit-only.)
function withMixinLinearizationConflictType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    castType: ts.TypeNode,
    linearizationMessage: string | undefined
): ts.TypeNode {
    if (linearizationMessage === undefined) {
        return castType
    }

    const factory      = tsInstance.factory
    const heritageType = implementsTypes(tsInstance, declaration)[0] ?? declaration
    const conflictType = factory.createTypeReferenceNode(mixinLinearizationConflictName, [
        preserveTextRange(
            tsInstance,
            factory.createLiteralTypeNode(factory.createStringLiteral(linearizationMessage)),
            heritageType
        )
    ])

    return factory.createIntersectionTypeNode([ castType, conflictType ])
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
    // Present when the mixin's own dependencies cannot be C3-linearized: the message is
    // surfaced as a never-constrained validation on the generated `__X$base`, exactly like a
    // consumer's linearization conflict (createLinearizationDiagnosticValidation).
    linearizationConflictMessage?: string
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
            fillMissedInitializers(tsInstance, addSyntheticSuperCallToConstructors(tsInstance, sourceFile, declaration.members, true), options)
        ) ]
    }

    const baseName = generatedName(declaration.name.text, consumerBaseSuffix)
    // Mirror the consumer's linearization diagnostic: a never-constrained validation type
    // parameter on `__X$base`, instantiated with the message in the (position-preserved)
    // generated heritage clause. Empty when there is no conflict.
    const linearizationValidations = linearizationConflictMessage === undefined
        ? []
        : [ createLinearizationDiagnosticValidation(
            tsInstance,
            declaration,
            linearizationConflictMessage,
            generatedHeritageTypeRange
        ) ]
    const baseTypeParameters  = () => appendSourceViewValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        linearizationValidations
    )
    const dependencyRefs           = localMixinRefs(context, dependencyHeritage)
    const facts                    = getSourceFileFacts(tsInstance, sourceFile, options)
    const baseImportMap            = context.crossFile === undefined
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
    const isConstructionMixin     = isConstructionBaseOptIn(
        tsInstance, sourceFile, requiredBase, options, facts, new Set(), context.crossFile, baseImportMap
    )
    const hasOwnConstructor       = declaration.members.some((member) => tsInstance.isConstructorDeclaration(member))
    const brandConstructionBase   = isConstructionMixin && !hasOwnConstructor
    const needsProtocolInitialize = dependencyRefs.length > 0 && isConstructionMixin

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
            createSourceViewMixinMetadataBase(tsInstance, sourceFile, declaration, requiredBase, dependencyRefs, brandConstructionBase)
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
    const updatedMembers      = fillMissedInitializers(tsInstance, addSyntheticSuperCallToConstructors(tsInstance, sourceFile, declaration.members, true), options)
    const mixinMembers        = constructionMembers.length === 0
        ? updatedMembers
        : preserveTextRange(tsInstance, factory.createNodeArray([ ...updatedMembers, ...constructionMembers ]), updatedMembers)

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
            generatedHeritageTypeRange,
            linearizationValidations.map((validation) => validation.typeArgument)
        ),
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
    dependencyRefs: ResolvedMixinRef[],
    isConstructionMixin = false
): ts.ExpressionWithTypeArguments {
    const factory = tsInstance.factory

    // A construction mixin brands the `$base` head so the real class refuses a direct `new`, in
    // parity with the emit value cast; a base-less / custom-required-base mixin keeps the permissive
    // head, so its direct `new` stays allowed.
    const construction          = isConstructionMixin && declaration.name !== undefined
        ? { consumerName: declaration.name.text, branded: true }
        : undefined
    const headType              = requiredBase === undefined
        ? factory.createTypeReferenceNode(anyConstructorName, undefined)
        : createSourceViewConsumerBaseHeadType(tsInstance, requiredBase, undefined, undefined, construction)
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
    sourceFile: ts.SourceFile,
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
                        mixinRuntimeMembers(tsInstance, sourceFile, declaration, options)
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
        ...localMixinHeritageTypes(tsInstance, declaration, context)
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
