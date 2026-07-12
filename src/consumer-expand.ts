import type * as ts from "typescript"
import {
    consumerBaseClassHeritage,
    consumerHeritageClauses,
    consumerRuntimeBaseType,
    isSupportedBaseExpression,
    unsupportedBaseConsumerHeritage
} from "./consumer-base-heritage.js"
import { navigableConsumerBaseClassHeritage } from "./consumer-navigable-heritage.js"
import { brandConstructorParameter, type ConstructionBrand } from "./construction-brand.js"
import {
    appendRequiredBaseValidationTypeParameters,
    appendSourceViewValidationTypeParameters,
    createNominalRequiredBaseValidation,
    createRequiredBaseValidations,
    linearizationDiagnosticMessage,
    pushLinearizationConflictDiagnostic,
    pushMissingRuntimeImportDiagnostics,
    pushRequiredBaseConflictDiagnostic,
    requiredBaseMismatchDiagnosticMessage,
    unsupportedBaseDiagnosticMessage
} from "./consumer-diagnostics.js"
import { addSyntheticSuperCallToConstructors } from "./consumer-constructors.js"
import { constructionProtocolInitializeSignature } from "./interface-members.js"
import { fillMissedInitializers } from "./construction-initializers.js"
import {
    createConstructionMembers,
    positionConstructionConfigAlias
} from "./construction-config.js"
import {
    isConstructionBaseOptIn
} from "./construction-chain.js"
import { buildImportedNameMap } from "./import-map.js"
import {
    cloneExpressionWithTypeArguments,
    MixinTransformError,
    substituteTypeParameterReferences,
    typeNodeReferencesTypeParameters,
    useSiteTypeParameterSubstitutions
} from "./expand-util.js"
import { deriveLinearizationPlan, linearizeDependencies } from "./linearization.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import { reduceTransitiveMixinHeritageTypes } from "./transitive-heritage-workaround.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import { createInstanceCollisionStatements, createStaticCollisionValidations } from "./static-collisions.js"
import {
    type ImportMap,
    nativeDiagnosticOn,
    DependencyLinearizationError,
    mixinDiagnosticCode,
    type FileMixinContext,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { consumerBaseSuffix, consumerEmptyBaseSuffix, emptyLocalName, generatedName } from "./naming.js"
import { extendsClause, requiredBaseType } from "./heritage.js"
import { generatedTextRange, preserveGeneratedDeclarationRange, preserveSourceViewGeneratedClassLikeRange, preserveTextRange } from "./text-range.js"
import type { RequiredBaseInstantiation } from "./required-base-plan.js"
import { deepCloneNode } from "./util.js"
import type { TypeScript } from "./util.js"

type ConsumerExpansionContext = {
    name                       : string,
    baseName                   : string,
    extendsType                : ts.ExpressionWithTypeArguments | undefined,
    directMixinRefs            : ResolvedMixinRef[],
    generatedRange             : ts.TextRange,
    sourceViewGeneratedRange   : ts.TextRange,
    originalExtendsClause      : ts.HeritageClause | undefined,
    keepsSourceImplements      : boolean,
    generatedHeritageRange     : ts.TextRange,
    generatedHeritageTypeRange : ts.TextRange
}

export function expandConsumerClass(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions,
    mixinHeritage = localMixinHeritageTypes(tsInstance, declaration, context)
): ts.Statement[] {
    const factory   = tsInstance.factory
    const expansion = createConsumerExpansionContext(
        tsInstance,
        sourceFile,
        declaration,
        context,
        options,
        mixinHeritage
    )
    let linearized: ResolvedMixinRef[]

    try {
        linearized = linearizeDependencies(
            expansion.directMixinRefs.map((ref) => ref.key),
            context
        )
    } catch (error) {
        if (error instanceof DependencyLinearizationError) {
            return expandConsumerClassWithLinearizationDiagnostic(
                tsInstance,
                sourceFile,
                declaration,
                context,
                expansion.directMixinRefs,
                error,
                options
            )
        }

        throw error
    }

    // Approach (B): the merge above succeeded, so the chain order can be precomputed as a
    // plan the runtime `mixinChainLinearized` replays instead of running C3 per consumer.
    const linearizationPlan = expansion.directMixinRefs.length === 0
        ? undefined
        : deriveLinearizationPlan(expansion.directMixinRefs.map((ref) => ref.key), context)
    // `localMixinRefs` maps the heritage list 1:1, so direct refs pair with their
    // use-site `implements` entries by index. The use site supplies the type arguments
    // that instantiate a generic mixin's constraint (`implements M<U>` -> `Base<U>`);
    // each direct ref's resolution folds its transitive dependencies internally with
    // the substitution composed along the chain.
    const directHeritageByRef    = new Map(
        expansion.directMixinRefs.map((directRef, index) => [ directRef, mixinHeritage[index]! ])
    )
    const requiredBaseResolution = context.crossFile?.requiredBases.resolveDirectRefs(
        sourceFile.fileName,
        expansion.directMixinRefs.map((ref, index) => ({ ref, heritage: mixinHeritage[index] }))
    )
    // The linearization is KEY-resolved, so for a NESTED mixin shadowing a same-named
    // top-level one it holds the top-level ref. The resolution above is LEXICAL (it
    // selected the nested twin's constraint), so plan matching and the implicit-base
    // fallback must see the lexical direct refs, or the selected constraint misses its
    // ref and the WRONG (top-level) base is materialized. Same-key substitution is exact:
    // the emitted chain values are plain identifiers resolved lexically at runtime.
    const directRefByKey    = new Map(expansion.directMixinRefs.map((directRef) => [ directRef.key, directRef ]))
    const linearizedForPlan = linearized.map((ref) => directRefByKey.get(ref.key) ?? ref)

    if (requiredBaseResolution?.conflict !== undefined) {
        pushRequiredBaseConflictDiagnostic(
            tsInstance,
            sourceFile,
            context,
            mixinHeritage[0] ?? declaration.name ?? declaration,
            requiredBaseResolution.conflict
        )
    }

    if (expansion.extendsType !== undefined && !isSupportedBaseExpression(tsInstance, expansion.extendsType.expression)) {
        return expandConsumerClassWithUnsupportedBaseDiagnostic(
            tsInstance,
            sourceFile,
            declaration,
            context,
            expansion.directMixinRefs,
            linearized,
            options,
            expansion.generatedRange,
            expansion.generatedHeritageRange,
            expansion.generatedHeritageTypeRange
        )
    }

    // The base/plan pair is derived ONCE, here, and travels together (REVIEW finding 1).
    // Exactly one of three shapes reaches the emit:
    //  - a SELECTED ref: plan = its one-based index, the runtime base expression is the
    //    literal `undefined` (the plan supplies the base — no phantom import);
    //  - KNOWN unconstrained with nothing found syntactically either: the generated
    //    `$empty` root with plan 0 (inert at runtime — the base is provided);
    //  - everything else (no cross-file context, a plan miss, an indeterminate generic
    //    resolution, or the resolver disagreeing with the syntactic side): the pre-plan
    //    emit — the implicit base expression (or `$empty`) with NO plan; the runtime
    //    required-base scan is the designed safety net.
    const planSelection              = expansion.extendsType === undefined && linearizationPlan !== undefined
        ? context.crossFile?.requiredBases.planSelection(sourceFile.fileName, linearizedForPlan, requiredBaseResolution)
        : undefined
    const selectedRequiredBaseRef    = planSelection?.selectedRef
    const selectedRequiredBaseImport = selectedRequiredBaseRef?.requiredBase?.import
    const selectedRequiredBaseFile   = selectedRequiredBaseImport === undefined || context.crossFile === undefined
        ? undefined
        : context.crossFile.resolveModuleFileName(selectedRequiredBaseImport.specifier, sourceFile.fileName)
    const canUseSelectedRequiredBase = selectedRequiredBaseRef?.declaration !== undefined ||
        (selectedRequiredBaseRef?.requiredBase !== undefined && (
            selectedRequiredBaseImport === undefined ||
            (selectedRequiredBaseFile !== undefined && context.crossFile?.requiredBases.canImportBase(
                selectedRequiredBaseFile,
                selectedRequiredBaseImport.importedName
            ) === true)
        ))
    // How the selected constraint spells its type arguments in THIS file: `raw` (no
    // foreign parameters — clone/alias as-is), an instantiated argument list, or
    // undefined (inexpressible → the TYPE-level base is dropped; the plan/value side
    // and the members flowing through the mixin interfaces are unaffected).
    const selectedInstantiation         = requiredBaseResolution?.selected === undefined
        ? undefined
        : context.crossFile?.requiredBases.instantiateBase(requiredBaseResolution.selected)
    const implicitRequiredBase          = expansion.extendsType !== undefined
        ? undefined
        : selectedRequiredBaseRef !== undefined
            ? instantiatedRequiredBaseTypeOfRef(
                tsInstance,
                context,
                selectedRequiredBaseRef,
                canUseSelectedRequiredBase,
                selectedInstantiation
            )
            : firstRequiredBaseType(tsInstance, context, linearizedForPlan, directHeritageByRef)
    const emptyBaseName                 = expansion.extendsType === undefined &&
        implicitRequiredBase === undefined && selectedRequiredBaseRef === undefined
        ? generatedName(expansion.name, consumerEmptyBaseSuffix)
        : undefined
    const requiredBasePlan              = expansion.extendsType !== undefined || linearizationPlan === undefined
        ? undefined
        : selectedRequiredBaseRef !== undefined
            ? planSelection!.plan
            : emptyBaseName !== undefined
                ? 0
                : undefined
    const nominalRequiredBaseValidation = expansion.extendsType !== undefined &&
        requiredBaseResolution?.selected !== undefined &&
        context.crossFile?.requiredBases.explicitBaseSatisfies(
            sourceFile.fileName,
            declaration,
            requiredBaseResolution.selected
        ) === false
        ? [ createNominalRequiredBaseValidation(
            tsInstance,
            declaration,
            expansion.generatedHeritageTypeRange,
            requiredBaseMismatchDiagnosticMessage(
                expansion.name,
                expansion.extendsType.getText(sourceFile),
                requiredBaseResolution.selected
            )
        ) ]
        : []
    const requiredBaseValidations       = expansion.extendsType === undefined
        ? []
        : [
            ...createRequiredBaseValidations(
                tsInstance,
                context,
                sourceFile,
                declaration,
                expansion.extendsType,
                linearizedForPlan,
                expansion.generatedHeritageTypeRange,
                options,
                directHeritageByRef
            ),
            ...nominalRequiredBaseValidation
        ]
    pushMissingRuntimeImportDiagnostics(
        tsInstance,
        sourceFile,
        declaration,
        context,
        expansion.directMixinRefs,
        mixinHeritage
    )
    const reducedMixinHeritage = reduceTransitiveMixinHeritageTypes(tsInstance, context, mixinHeritage)
    const facts                = getSourceFileFacts(tsInstance, sourceFile, options)
    const consumerBaseImports  = consumerBaseImportMap(tsInstance, sourceFile, context, linearized, facts)
    // A construction consumer transitively extends the package `Base` (so it gets a
    // generated static `new` factory). This mirrors `createConstructionMembers`' own
    // gate: an applied mixin's required base may itself be the package `Base`, or the
    // consumer's explicit/implicit base resolves to it (locally or cross-file).
    const isConstructionConsumer = linearized.some((ref) => ref.requiredBase?.isPackageBase === true) ||
        isConstructionBaseOptIn(
            tsInstance,
            sourceFile,
            expansion.extendsType ?? implicitRequiredBase,
            options,
            facts,
            new Set(),
            context.crossFile,
            consumerBaseImports
        )
    // A construction consumer refuses a direct `new Consumer(...)` (construction goes through the
    // static `new`). When it declares NO constructor of its own, the brand rides on the `$base`
    // cast's construct signature, which the consumer inherits. When it DOES declare a constructor,
    // that constructor's own signature — not `$base`'s — governs an external `new`, so branding
    // `$base` is useless there (and would only break the constructor's `super()`); the brand goes
    // on the constructor's parameter instead (emit only — see below).
    const hasOwnConstructor          = declaration.members.some((member) => tsInstance.isConstructorDeclaration(member))
    const brandsConstruction         = isConstructionConsumer && !hasOwnConstructor
    const staticCollisionValidations = createStaticCollisionValidations(
        tsInstance,
        sourceFile,
        declaration,
        expansion.extendsType,
        implicitRequiredBase,
        emptyBaseName,
        linearized,
        expansion.generatedHeritageTypeRange,
        facts,
        options.staticCollisionCheck,
        options.sourceView
    )
    const consumerValidations        = [
        ...requiredBaseValidations,
        ...staticCollisionValidations
    ]
    // Each generated declaration gets its own type parameter clones: reusing one
    // node in two declarations breaks name resolution in tsserver because the
    // binder reassigns the node parent to the last declaration.
    const checkedTypeParameters = () => options.sourceView
        ? appendSourceViewValidationTypeParameters(tsInstance, declaration.typeParameters, consumerValidations)
        : appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            consumerValidations
        )

    const construction        = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        expansion.extendsType,
        implicitRequiredBase,
        linearized,
        options,
        options.sourceView ? generatedTextRange(sourceFile, declaration.members.end) : expansion.generatedRange,
        context.crossFile,
        consumerBaseImports,
        linearized.some((ref) => ref.requiredBase?.isPackageBase === true),
        context.nativeDiagnostics,
        context.usedFactoryImports
    )
    const constructionMembers = construction.members
    // A construction consumer that declares its OWN constructor brands THAT constructor's parameter
    // so an external `new Consumer(...)` is a type error while its `super()` stays valid against the
    // clean `$base`. EMIT only: the brand inserts a parameter (shifting the constructor body), which
    // emit absorbs via its diagnostic remap but position-preserving source view cannot — so in the
    // IDE a with-constructor consumer is left un-banned, and the build (`tsc`) is what catches it.
    const brandedConsumerSource    = !options.sourceView && isConstructionConsumer && hasOwnConstructor && declaration.name !== undefined
        ? brandConstructorParameter(tsInstance, declaration.members, declaration.name.text)
        : declaration.members
    const consumerMembersWithSuper = addSyntheticSuperCallToConstructors(
        tsInstance,
        sourceFile,
        brandedConsumerSource,
        expansion.originalExtendsClause === undefined
    )
    const consumerMembers          = isConstructionConsumer
        ? fillMissedInitializers(tsInstance, consumerMembersWithSuper, options)
        : consumerMembersWithSuper
    const updatedConsumerMembers   = constructionMembers.length === 0
        ? consumerMembers
        : preserveTextRange(tsInstance, factory.createNodeArray([ ...consumerMembers, ...constructionMembers ]), consumerMembers)

    // Source-view navigable-base fast path: a well-typed consumer with an explicit
    // `extends Base` (or `extends ns.Base`) and no diagnostic validations needs no
    // `$base` indirection. The consumer re-extends the real base under a
    // single-source cast (`extends (Base as unknown as <ctor carrying base + mixin
    // instances> & <statics>)`), so the base name in `extends Base` resolves to the
    // real base class — closing the heritage-navigation gap — while
    // `super.<mixinMember>`, statics and own members all keep resolving. A GENERIC
    // consumer threads its type parameters through the cast's generic construct
    // signature and back as heritage type arguments (TS2562 bans them only in the
    // base expression); a CONSTRUCTION consumer's brand (or the permissive
    // manual-constructor form) rides inside that construct signature; a QUALIFIED
    // base pins every step of the access chain onto its own source token.
    // Diagnostic validations only arise on broken code; those keep the `$base`
    // carrier below, which positions their diagnostics onto the source base name.
    const hasEntityNameBase = expansion.extendsType !== undefined &&
        isSupportedBaseExpression(tsInstance, expansion.extendsType.expression)

    // The config alias (and the emit-only meta companion) go AFTER the consumer: their
    // anchor is just past the closing brace, so listing them last keeps the statement
    // ranges ordered and non-overlapping.
    const configAliasStatement = [ construction.configAlias, construction.configMeta ]
        .filter((companion): companion is ts.TypeAliasDeclaration => companion !== undefined)
        .map((companion) => positionConstructionConfigAlias(
            tsInstance,
            companion,
            generatedTextRange(sourceFile, declaration.end),
            declaration
        ))

    if (options.sourceView &&
        consumerValidations.length === 0 &&
        expansion.extendsType !== undefined &&
        hasEntityNameBase) {
        return [
            ...expandNavigableSourceViewConsumer(
                tsInstance,
                sourceFile,
                declaration,
                expansion.extendsType,
                reducedMixinHeritage,
                linearized,
                updatedConsumerMembers,
                isConstructionConsumer
                    ? { consumerName: expansion.name, branded: brandsConstruction }
                    : undefined
            ),
            // The fast path's intersection cast silently absorbs incompatible same-named
            // instance members (`string & number = never`) that the `$base` interface of
            // every other shape surfaces as TS2320 — this facts-gated carrier restores the
            // diagnostic (§7.27).
            ...createInstanceCollisionStatements(
                tsInstance,
                sourceFile,
                declaration,
                expansion.extendsType,
                reducedMixinHeritage,
                facts
            ),
            ...configAliasStatement
        ]
    }

    // The `$base` carrier pair, built only when the fast path above did not take the
    // consumer (a validation-carrying, implicit-base or unsupported-base shape).
    //
    // A construction consumer's `$base` interface extends `Base` plus mixins that may
    // each override the cooperative `initialize` with their own strict `<Mixin>Config`.
    // Those overrides are NOT identical, so an interface inheriting two of them fails with
    // TS2320 ("cannot simultaneously extend ... 'initialize' ... not identical"). The
    // overrides are legitimate, so rather than forbid them we re-declare the
    // `Base.initialize` protocol signature here: an own member overrides the conflicting
    // inherited ones, so the merge succeeds while each mixin keeps its strict body. Gated
    // to construction consumers so a non-construction consumer of plain mixins still
    // surfaces a genuine `initialize` clash.
    const protocolInitialize = isConstructionConsumer
        ? constructionProtocolInitializeSignature(tsInstance)
        : undefined
    const baseInterfaceNode  = factory.createInterfaceDeclaration(
        undefined,
        expansion.baseName,
        checkedTypeParameters(),
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                // In source view, even a base without type arguments goes into
                // interface extends so cloned heritage types map to originals 1:1.
                ...(expansion.extendsType !== undefined && (options.sourceView || expansion.extendsType.typeArguments !== undefined)
                    ? [ cloneExpressionWithTypeArguments(tsInstance, expansion.extendsType) ]
                    : []),
                ...(implicitRequiredBase === undefined
                    ? []
                    : [ cloneExpressionWithTypeArguments(tsInstance, implicitRequiredBase) ]),
                ...reducedMixinHeritage.map((heritageType) => {
                    return cloneExpressionWithTypeArguments(tsInstance, heritageType)
                })
            ]
        ) ],
        protocolInitialize === undefined ? [] : [ protocolInitialize ]
    )
    const baseInterface      = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseInterfaceNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseInterfaceNode, expansion.generatedRange, declaration)

    const baseClassNode = factory.createClassDeclaration(
        undefined,
        expansion.baseName,
        checkedTypeParameters(),
        [ consumerBaseClassHeritage(
            tsInstance,
            expansion.extendsType,
            implicitRequiredBase,
            emptyBaseName,
            expansion.directMixinRefs,
            linearized,
            options,
            isConstructionConsumer
                ? { consumerName: expansion.name, branded: brandsConstruction }
                : undefined,
            linearizationPlan,
            requiredBasePlan
        ) ],
        []
    )
    const baseClass     = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseClassNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseClassNode, expansion.generatedRange, declaration)

    const updatedConsumer = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        consumerHeritageClauses(
            tsInstance,
            declaration,
            expansion.baseName,
            expansion.generatedHeritageRange,
            expansion.generatedHeritageTypeRange,
            consumerValidations.map((validation) => validation.typeArgument),
            !options.sourceView || expansion.originalExtendsClause !== undefined || expansion.keepsSourceImplements
        ),
        updatedConsumerMembers
    )

    const emptyBaseClass = emptyBaseName === undefined
        ? []
        : [ options.sourceView
            ? preserveGeneratedDeclarationRange(
                tsInstance,
                createConsumerEmptyBaseClass(tsInstance, emptyBaseName, true),
                expansion.sourceViewGeneratedRange,
                declaration
            )
            : preserveGeneratedDeclarationRange(
                tsInstance,
                createConsumerEmptyBaseClass(tsInstance, emptyBaseName, false),
                expansion.generatedRange,
                declaration
            ) ]

    return [ ...emptyBaseClass, baseInterface, baseClass, updatedConsumer, ...configAliasStatement ]
}

// Builds the source-view navigable-base fast path: the consumer class re-extends
// the real base under a single-source cast carrying the base + mixin instances and
// statics (generic construct signature for a generic consumer, branded/permissive
// for a construction consumer). No generated `$base` is emitted. See the call site
// in `expandConsumerClass` for when this applies.
function expandNavigableSourceViewConsumer(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments,
    reducedMixinHeritage: ts.ExpressionWithTypeArguments[],
    linearizedMixinRefs: ResolvedMixinRef[],
    members: ts.NodeArray<ts.ClassElement>,
    construction: ConstructionBrand | undefined
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const navigableExtends = navigableConsumerBaseClassHeritage(
        tsInstance,
        extendsType,
        reducedMixinHeritage,
        linearizedMixinRefs,
        extendsType,
        declaration.typeParameters,
        construction
    )
    const implementsClause = declaration.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ImplementsKeyword
    })
    const heritageClauses  = preserveTextRange(
        tsInstance,
        factory.createNodeArray(implementsClause === undefined
            ? [ navigableExtends ]
            : [ navigableExtends, implementsClause ]),
        declaration.heritageClauses ?? extendsType
    )

    const updatedConsumer = factory.updateClassDeclaration(
        declaration,
        declaration.modifiers,
        declaration.name,
        declaration.typeParameters,
        heritageClauses,
        members
    )

    return [ updatedConsumer ]
}

function createConsumerExpansionContext(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    options: TransformOptions,
    mixinHeritage: ts.ExpressionWithTypeArguments[]
): ConsumerExpansionContext {
    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name                     = declaration.name.text
    const originalExtendsClause    = extendsClause(tsInstance, declaration)
    const extendsType              = originalExtendsClause?.types[0]
    const generatedRange           = options.sourceView ? declaration : generatedTextRange(sourceFile, declaration.pos)
    const sourceViewGeneratedRange = generatedTextRange(sourceFile, declaration.pos)
    // A source-view consumer with no `extends` but an `implements` clause keeps its
    // real `implements` clause (like the emit path) so its source mixin references
    // (`SourceClass1<T>, SourceClass2<A>`) stay navigable. The generated `extends
    // $base` has no source text of its own, so anchor it at a tight synthetic
    // width-1 range before the `implements` keyword rather than stretching a single
    // `$base<...>` over the whole multi-type clause — that stranded the dropped
    // source types and their type arguments in SyntaxList trivia gaps (invariant #5).
    const keepsSourceImplements      = options.sourceView &&
        originalExtendsClause === undefined &&
        declaration.heritageClauses !== undefined
    const generatedHeritageRange     = originalExtendsClause ??
        (keepsSourceImplements
            ? generatedTextRange(sourceFile, declaration.heritageClauses!.pos)
            : generatedTextRange(
                sourceFile,
                declaration.heritageClauses?.pos ?? declaration.name.end
            ))
    const generatedHeritageTypeRange = extendsType ?? generatedHeritageRange

    return {
        name,
        baseName        : generatedName(name, consumerBaseSuffix),
        extendsType,
        directMixinRefs : localMixinRefs(tsInstance, context, mixinHeritage),
        generatedRange,
        sourceViewGeneratedRange,
        originalExtendsClause,
        keepsSourceImplements,
        generatedHeritageRange,
        generatedHeritageTypeRange
    }
}

function expandConsumerClassWithUnsupportedBaseDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    directMixinRefs: ResolvedMixinRef[],
    linearizedMixinRefs: ResolvedMixinRef[],
    options: TransformOptions,
    generatedRange: ts.TextRange,
    generatedHeritageRange: ts.TextRange,
    generatedHeritageTypeRange: ts.TextRange
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name                 = declaration.name.text
    const baseName             = generatedName(name, consumerBaseSuffix)
    const extendsType          = extendsClause(tsInstance, declaration)?.types[0]
    const mixinHeritage        = localMixinHeritageTypes(tsInstance, declaration, context)
    const reducedMixinHeritage = reduceTransitiveMixinHeritageTypes(tsInstance, context, mixinHeritage)

    if (extendsType === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "Unsupported base diagnostic requires an extends clause")
    }

    // The base expression is not a named class we can resolve. This is a purely syntactic finding,
    // so it is a NATIVE diagnostic (family code TS990005), spanned on the offending base expression
    // and drained by `wrapProgramDiagnostics` — surfaced identically on the emit and source-view
    // planes. The generated declarations below are a still-type-correct fallback (no `never` carrier).
    //
    // Only the GENUINE on-disk unsupported base carries a real position. A construction consumer is
    // re-expanded from a synthesized declaration whose base was already validated and rewritten into a
    // `(mixinChain(...) as unknown as ...)` cast (a `ParenthesizedExpression`, pos < 0); that is not an
    // error, so the push (and `getStart`, which asserts a real position) is gated on a real position —
    // exactly the boundary the old type-encoded carrier got for free by riding the discarded node.
    if (extendsType.expression.pos >= 0 && extendsType.expression.end >= 0) {
        context.nativeDiagnostics.push(nativeDiagnosticOn(
            tsInstance,
            sourceFile,
            extendsType.expression,
            mixinDiagnosticCode.MixinUnsupportedBase,
            unsupportedBaseDiagnosticMessage(tsInstance, sourceFile, declaration, extendsType)
        ))
    }

    const checkedTypeParameters = appendRequiredBaseValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        []
    )

    const baseInterface = preserveGeneratedDeclarationRange(
        tsInstance,
        factory.createInterfaceDeclaration(
            undefined,
            baseName,
            checkedTypeParameters,
            [ factory.createHeritageClause(
                tsInstance.SyntaxKind.ExtendsKeyword,
                reducedMixinHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
            ) ],
            []
        ),
        generatedRange,
        declaration
    )

    const baseClass = preserveGeneratedDeclarationRange(
        tsInstance,
        factory.createClassDeclaration(
            undefined,
            baseName,
            appendRequiredBaseValidationTypeParameters(
                tsInstance,
                declaration.typeParameters,
                []
            ),
            [ unsupportedBaseConsumerHeritage(
                tsInstance,
                extendsType,
                directMixinRefs,
                linearizedMixinRefs,
                options
            ) ],
            []
        ),
        generatedRange,
        declaration
    )

    const updatedConsumer = factory.updateClassDeclaration(
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
        addSyntheticSuperCallToConstructors(
            tsInstance,
            sourceFile,
            declaration.members,
            extendsType === undefined
        )
    )

    return [ baseInterface, baseClass, updatedConsumer ]
}

function expandConsumerClassWithLinearizationDiagnostic(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    context: FileMixinContext,
    directMixinRefs: ResolvedMixinRef[],
    error: DependencyLinearizationError,
    options: TransformOptions
): ts.Statement[] {
    const factory = tsInstance.factory

    if (declaration.name === undefined) {
        throw new MixinTransformError(sourceFile, declaration, "A mixin consumer class must have a name")
    }

    const name                       = declaration.name.text
    const baseName                   = generatedName(name, consumerBaseSuffix)
    const extendsType                = extendsClause(tsInstance, declaration)?.types[0]
    const emptyBaseName              = extendsType === undefined ? generatedName(name, consumerEmptyBaseSuffix) : undefined
    const mixinHeritage              = localMixinHeritageTypes(tsInstance, declaration, context)
    const reducedMixinHeritage       = reduceTransitiveMixinHeritageTypes(tsInstance, context, mixinHeritage)
    const generatedRange             = generatedTextRange(sourceFile, declaration.pos)
    const originalExtendsClause      = extendsClause(tsInstance, declaration)
    const generatedHeritageRange     = originalExtendsClause ?? generatedTextRange(
        sourceFile,
        declaration.heritageClauses?.pos ?? declaration.name.end
    )
    const generatedHeritageTypeRange = extendsType ?? generatedHeritageRange

    pushLinearizationConflictDiagnostic(
        tsInstance,
        sourceFile,
        context,
        mixinHeritage[0] ?? declaration.name,
        linearizationDiagnosticMessage(directMixinRefs, context, error)
    )

    const checkedTypeParameters = appendRequiredBaseValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        []
    )

    const baseInterfaceNode = factory.createInterfaceDeclaration(
        undefined,
        baseName,
        checkedTypeParameters,
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            [
                ...(extendsType?.typeArguments !== undefined ? [ cloneExpressionWithTypeArguments(tsInstance, extendsType) ] : []),
                ...reducedMixinHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
            ]
        ) ],
        []
    )
    // The cloned heritage keeps its source positions; in source view route the
    // generated `$base` through the range mapper (which maps the cloned mixin
    // references onto the source `implements`/`extends` and keeps the helper from
    // spanning the consumer's name) rather than the throwaway emit range, which
    // would otherwise strand the consumer name in the helper's trivia (invariant #5).
    const baseInterface = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseInterfaceNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseInterfaceNode, generatedRange, declaration)

    const baseClassNode = factory.createClassDeclaration(
        undefined,
        baseName,
        appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            []
        ),
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            cloneExpressionWithTypeArguments(
                tsInstance,
                consumerRuntimeBaseType(tsInstance, extendsType, undefined, emptyBaseName)
            )
        ]) ],
        []
    )
    const baseClass     = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseClassNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseClassNode, generatedRange, declaration)

    const updatedConsumer = factory.updateClassDeclaration(
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
        addSyntheticSuperCallToConstructors(
            tsInstance,
            sourceFile,
            declaration.members,
            extendsType === undefined
        )
    )

    const emptyBaseClass = emptyBaseName === undefined
        ? []
        : [ preserveGeneratedDeclarationRange(
            tsInstance,
            createConsumerEmptyBaseClass(tsInstance, emptyBaseName, options.sourceView),
            generatedRange,
            declaration
        ) ]

    return [ ...emptyBaseClass, baseInterface, baseClass, updatedConsumer ]
}

function createConsumerEmptyBaseClass(
    tsInstance: TypeScript,
    name: string,
    sourceView: boolean
): ts.ClassDeclaration {
    return tsInstance.factory.createClassDeclaration(
        undefined,
        name,
        undefined,
        sourceView
            ? undefined
            : [ tsInstance.factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
                tsInstance.factory.createExpressionWithTypeArguments(
                    tsInstance.factory.createIdentifier(emptyLocalName),
                    undefined
                )
            ]) ],
        []
    )
}

// The selected constraint's base as an heritage node for THIS file: the existing
// clone/alias path when `instantiation` is `raw`, the use-site-instantiated argument
// list otherwise, and NOTHING when the constraint is inexpressible here — dropping the
// type-level base beats leaking a foreign type parameter (the members still flow through
// each mixin's own generated interface; the plan/runtime side is untouched).
function instantiatedRequiredBaseTypeOfRef(
    tsInstance: TypeScript,
    context: FileMixinContext,
    ref: ResolvedMixinRef,
    allowImportedBase: boolean,
    instantiation: RequiredBaseInstantiation | undefined
): ts.ExpressionWithTypeArguments | undefined {
    if (instantiation === undefined) {
        return undefined
    }

    const requiredBase = requiredBaseTypeOfRef(tsInstance, context, ref, allowImportedBase)

    if (requiredBase === undefined || instantiation.raw) {
        return requiredBase
    }

    return tsInstance.factory.createExpressionWithTypeArguments(
        deepCloneNode(tsInstance, requiredBase.expression),
        instantiation.typeArguments
    )
}

function firstRequiredBaseType(
    tsInstance: TypeScript,
    context: FileMixinContext,
    mixinRefs: ResolvedMixinRef[],
    directHeritageByRef?: ReadonlyMap<ResolvedMixinRef, ts.ExpressionWithTypeArguments>
): ts.ExpressionWithTypeArguments | undefined {
    for (const ref of mixinRefs) {
        const requiredBase = requiredBaseTypeOfRef(tsInstance, context, ref)

        if (requiredBase === undefined) {
            continue
        }

        // A generic mixin's declared base references ITS OWN type parameters, which do
        // not exist in the consumer's scope — cloned as-is it fails with TS2304 (local
        // declaration) or TS2314 (a bare generic cross-file alias) on a generated line.
        // Instantiate from the direct use site when the arguments are spelled out;
        // otherwise skip the ref — the runtime scan owns the base anyway (this fallback
        // only runs without a selected plan).
        if (ref.declaration === undefined) {
            const instantiation = context.crossFile?.requiredBases.importedBaseInstantiation(
                ref.key,
                directHeritageByRef?.get(ref)
            ) ?? { raw: true as const }

            if (instantiation === undefined) {
                continue
            }

            return instantiation.raw
                ? requiredBase
                : tsInstance.factory.createExpressionWithTypeArguments(
                    deepCloneNode(tsInstance, requiredBase.expression),
                    instantiation.typeArguments
                )
        }

        const ownParameterNames = new Set(
            (ref.declaration.typeParameters ?? []).map((parameter) => parameter.name.text)
        )

        if (ownParameterNames.size === 0 ||
            !typeNodeReferencesTypeParameters(tsInstance, requiredBase, ownParameterNames)
        ) {
            return requiredBase
        }

        const substitutions = useSiteTypeParameterSubstitutions(ref.declaration, directHeritageByRef?.get(ref))

        if (substitutions === undefined) {
            continue
        }

        return tsInstance.factory.createExpressionWithTypeArguments(
            deepCloneNode(tsInstance, requiredBase.expression),
            requiredBase.typeArguments?.map((argument) =>
                substituteTypeParameterReferences(tsInstance, deepCloneNode(tsInstance, argument), substitutions))
        )
    }

    return undefined
}

function requiredBaseTypeOfRef(
    tsInstance: TypeScript,
    context: FileMixinContext,
    ref: ResolvedMixinRef | undefined,
    allowImportedBase = true
): ts.ExpressionWithTypeArguments | undefined {
    if (ref === undefined) {
        return undefined
    }

    if (ref.declaration !== undefined) {
        return requiredBaseType(tsInstance, ref.declaration)
    }

    if (!allowImportedBase || ref.requiredBase === undefined) {
        return undefined
    }

    if (ref.requiredBase.import !== undefined) {
        context.usedFactoryImports.set(
            `${ref.requiredBase.import.specifier}:${ref.requiredBase.import.localName}`,
            ref.requiredBase.import
        )
    }

    return tsInstance.factory.createExpressionWithTypeArguments(
        tsInstance.factory.createIdentifier(ref.requiredBase.localName),
        undefined
    )
}

// Base import map for the consumer, augmented with the generated aliases of any
// cross-file required bases (e.g. `Mixin$requiredBase`). The implicit required
// base produced by `firstRequiredBaseType` uses that alias as its identifier, so
// mapping it back to the imported class lets construction-base resolution reach
// the cross-file registry entry.
function consumerBaseImportMap(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    context: FileMixinContext,
    mixinRefs: ResolvedMixinRef[],
    facts: SourceFileFacts
): ImportMap | undefined {
    const crossFile = context.crossFile

    if (crossFile === undefined) {
        return undefined
    }

    const baseImportMap = buildImportedNameMap(tsInstance, sourceFile, crossFile.resolveModuleFileName, facts)

    for (const ref of mixinRefs) {
        const requiredBase = ref.requiredBase

        if (requiredBase?.import === undefined) {
            continue
        }

        const resolvedFileName = crossFile.resolveModuleFileName(requiredBase.import.specifier, sourceFile.fileName)

        if (resolvedFileName === undefined) {
            continue
        }

        baseImportMap.set(requiredBase.localName, {
            resolvedFileName,
            importedName : requiredBase.import.importedName,
            typeOnly     : false
        })
    }

    return baseImportMap
}
