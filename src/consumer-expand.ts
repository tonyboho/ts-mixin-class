import type * as ts from "typescript"
import {
    consumerBaseClassHeritage,
    consumerRuntimeBaseType,
    isSupportedBaseExpression,
    unsupportedBaseConsumerHeritage
} from "./consumer-base-heritage.js"
import {
    appendRequiredBaseValidationTypeParameters,
    appendSourceViewValidationTypeParameters,
    createConsumerDiagnosticValidation,
    createLinearizationDiagnosticValidation,
    createMissingRuntimeImportValidations,
    createRequiredBaseValidations,
    linearizationDiagnosticMessage,
    unsupportedBaseDiagnosticMessage
} from "./consumer-diagnostics.js"
import { addSyntheticSuperCallToConstructors } from "./consumer-constructors.js"
import { rewritePublicOnlyUndefinedInitializers } from "./construction-initializers.js"
import {
    createConstructionMembers,
    isConstructionBaseOptIn
} from "./construction-config.js"
import { buildImportedNameMap } from "./context.js"
import {
    cloneExpressionWithTypeArguments,
    consumerHeritageClauses,
    MixinTransformError
} from "./expand-util.js"
import { linearizeDependencies } from "./linearization.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import { reduceTransitiveMixinHeritageTypes } from "./transitive-heritage-workaround.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import { createStaticCollisionValidations } from "./static-collisions.js"
import {
    consumerBaseSuffix,
    consumerEmptyBaseSuffix,
    DependencyLinearizationError,
    extendsClause,
    generatedName,
    requiredBaseType,
    type FileMixinContext,
    type ImportedNameBinding,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    generatedTextRange,
    preserveGeneratedDeclarationRange,
    preserveSourceViewGeneratedClassLikeRange,
    preserveTextRange
} from "./util.js"
import type { TypeScript } from "./util.js"

type ConsumerExpansionContext = {
    name                       : string,
    baseName                   : string,
    extendsType                : ts.ExpressionWithTypeArguments | undefined,
    directMixinRefs            : ResolvedMixinRef[],
    generatedRange             : ts.TextRange,
    sourceViewGeneratedRange   : ts.TextRange,
    originalExtendsClause      : ts.HeritageClause | undefined,
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
                error
            )
        }

        throw error
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

    const implicitRequiredBase            = expansion.extendsType === undefined
        ? firstRequiredBaseType(tsInstance, context, linearized)
        : undefined
    const emptyBaseName                   = expansion.extendsType === undefined && implicitRequiredBase === undefined
        ? generatedName(expansion.name, consumerEmptyBaseSuffix)
        : undefined
    const requiredBaseValidations         = expansion.extendsType === undefined
        ? []
        : createRequiredBaseValidations(
            tsInstance,
            context,
            sourceFile,
            declaration,
            expansion.extendsType,
            linearized,
            expansion.generatedHeritageTypeRange,
            options
        )
    const missingRuntimeImportValidations = createMissingRuntimeImportValidations(
        tsInstance,
        declaration,
        expansion.directMixinRefs,
        mixinHeritage
    )
    const reducedMixinHeritage            = reduceTransitiveMixinHeritageTypes(tsInstance, context, mixinHeritage)
    const facts                           = getSourceFileFacts(tsInstance, sourceFile, options)
    const staticCollisionValidations      = createStaticCollisionValidations(
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
    const consumerValidations             = [
        ...requiredBaseValidations,
        ...missingRuntimeImportValidations,
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

    const baseInterfaceNode = factory.createInterfaceDeclaration(
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
        []
    )
    const baseInterface     = options.sourceView
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
            options
        ) ],
        []
    )
    const baseClass     = options.sourceView
        ? preserveSourceViewGeneratedClassLikeRange(tsInstance, baseClassNode, declaration)
        : preserveGeneratedDeclarationRange(tsInstance, baseClassNode, expansion.generatedRange, declaration)

    const constructionMembers      = createConstructionMembers(
        tsInstance,
        sourceFile,
        declaration,
        expansion.extendsType,
        implicitRequiredBase,
        linearized,
        options,
        options.sourceView ? generatedTextRange(sourceFile, declaration.members.end) : expansion.generatedRange,
        context.crossFile,
        consumerBaseImportMap(tsInstance, sourceFile, context, linearized, facts),
        linearized.some((ref) => ref.requiredBase?.isPackageBase === true)
    )
    const consumerMembersWithSuper = addSyntheticSuperCallToConstructors(
        tsInstance,
        sourceFile,
        declaration.members,
        expansion.originalExtendsClause === undefined
    )
    const consumerMembers          = isConstructionBaseOptIn(
        tsInstance,
        sourceFile,
        expansion.extendsType ?? implicitRequiredBase,
        options
    )
        ? rewritePublicOnlyUndefinedInitializers(tsInstance, consumerMembersWithSuper, options)
        : consumerMembersWithSuper
    const updatedConsumerMembers   = constructionMembers.length === 0
        ? consumerMembers
        : preserveTextRange(tsInstance, factory.createNodeArray([ ...consumerMembers, ...constructionMembers ]), consumerMembers)
    const updatedConsumer          = factory.updateClassDeclaration(
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
            !options.sourceView || expansion.originalExtendsClause !== undefined
        ),
        updatedConsumerMembers
    )

    const emptyBaseClass = emptyBaseName === undefined
        ? []
        : [ options.sourceView
            ? preserveGeneratedDeclarationRange(
                tsInstance,
                factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
                expansion.sourceViewGeneratedRange,
                declaration
            )
            : preserveGeneratedDeclarationRange(
                tsInstance,
                factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
                expansion.generatedRange,
                declaration
            ) ]

    return [ ...emptyBaseClass, baseInterface, baseClass, updatedConsumer ]
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

    const name                       = declaration.name.text
    const originalExtendsClause      = extendsClause(tsInstance, declaration)
    const extendsType                = originalExtendsClause?.types[0]
    const generatedRange             = options.sourceView ? declaration : generatedTextRange(sourceFile, declaration.pos)
    const sourceViewGeneratedRange   = generatedTextRange(sourceFile, declaration.pos)
    const firstHeritageType          = declaration.heritageClauses?.[0]?.types[0]
    const generatedHeritageRange     = originalExtendsClause ??
        (options.sourceView && declaration.heritageClauses !== undefined
            ? { pos: declaration.heritageClauses.pos, end: declaration.heritageClauses.end }
            : generatedTextRange(
                sourceFile,
                declaration.heritageClauses?.pos ?? declaration.name.end
            ))
    const generatedHeritageTypeRange = extendsType ??
        (options.sourceView && firstHeritageType !== undefined ? firstHeritageType : generatedHeritageRange)

    return {
        name,
        baseName        : generatedName(name, consumerBaseSuffix),
        extendsType,
        directMixinRefs : localMixinRefs(context, mixinHeritage),
        generatedRange,
        sourceViewGeneratedRange,
        originalExtendsClause,
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

    const diagnosticValidation  = createConsumerDiagnosticValidation(
        tsInstance,
        declaration,
        "__mixinUnsupportedBaseExpression",
        unsupportedBaseDiagnosticMessage(tsInstance, sourceFile, declaration, extendsType),
        generatedHeritageTypeRange
    )
    const checkedTypeParameters = appendRequiredBaseValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        [ diagnosticValidation ]
    )

    const baseInterface = preserveGeneratedDeclarationRange(tsInstance, factory.createInterfaceDeclaration(
        undefined,
        baseName,
        checkedTypeParameters,
        [ factory.createHeritageClause(
            tsInstance.SyntaxKind.ExtendsKeyword,
            reducedMixinHeritage.map((heritageType) => cloneExpressionWithTypeArguments(tsInstance, heritageType))
        ) ],
        []
    ), generatedRange, declaration)

    const baseClass = preserveGeneratedDeclarationRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            [ diagnosticValidation ]
        ),
        [ unsupportedBaseConsumerHeritage(
            tsInstance,
            extendsType,
            directMixinRefs,
            linearizedMixinRefs,
            options
        ) ],
        []
    ), generatedRange, declaration)

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
            generatedHeritageTypeRange,
            [ diagnosticValidation.typeArgument ]
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
    error: DependencyLinearizationError
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
    const diagnosticValidation       = createLinearizationDiagnosticValidation(
        tsInstance,
        declaration,
        linearizationDiagnosticMessage(directMixinRefs, context, error),
        generatedHeritageTypeRange
    )
    const checkedTypeParameters      = appendRequiredBaseValidationTypeParameters(
        tsInstance,
        declaration.typeParameters,
        [ diagnosticValidation ]
    )

    const baseInterface = preserveGeneratedDeclarationRange(tsInstance, factory.createInterfaceDeclaration(
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
    ), generatedRange, declaration)

    const baseClass = preserveGeneratedDeclarationRange(tsInstance, factory.createClassDeclaration(
        undefined,
        baseName,
        appendRequiredBaseValidationTypeParameters(
            tsInstance,
            declaration.typeParameters,
            [ diagnosticValidation ]
        ),
        [ factory.createHeritageClause(tsInstance.SyntaxKind.ExtendsKeyword, [
            cloneExpressionWithTypeArguments(
                tsInstance,
                consumerRuntimeBaseType(tsInstance, extendsType, undefined, emptyBaseName)
            )
        ]) ],
        []
    ), generatedRange, declaration)

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
            generatedHeritageTypeRange,
            [ diagnosticValidation.typeArgument ]
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
            factory.createClassDeclaration(undefined, emptyBaseName, undefined, undefined, []),
            generatedRange,
            declaration
        ) ]

    return [ ...emptyBaseClass, baseInterface, baseClass, updatedConsumer ]
}

function firstRequiredBaseType(
    tsInstance: TypeScript,
    context: FileMixinContext,
    mixinRefs: ResolvedMixinRef[]
): ts.ExpressionWithTypeArguments | undefined {
    for (const ref of mixinRefs) {
        if (ref.declaration === undefined) {
            if (ref.requiredBase === undefined) {
                continue
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

        const requiredBase = requiredBaseType(tsInstance, ref.declaration)

        if (requiredBase !== undefined) {
            return requiredBase
        }
    }

    return undefined
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
): Map<string, ImportedNameBinding> | undefined {
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
