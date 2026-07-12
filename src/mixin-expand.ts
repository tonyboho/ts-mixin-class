import type * as ts from "typescript"
import {
    buildInterfaceMembers,
    constructionProtocolInitializeSignature,
    declaresInstanceInitialize,
    interfaceDeclarationRange
} from "./interface-members.js"
import {
    nativeDiagnosticOn,
    DependencyLinearizationError,
    mixinDiagnosticCode,
    registryKey,
    type FileMixinContext,
    type NativeMixinDiagnostic,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import {
    defineMixinClassLocalName,
    generatedName,
    mixinRuntimeClassSuffix
} from "./naming.js"
import { requiredBaseType } from "./heritage.js"
import { createLinearizationPlanLiteral, linearizationMode } from "./linearization.js"
import { mixinValueIdentifier } from "./entity-name.js"
import {
    linearizationDiagnosticMessage,
    pushLinearizationConflictDiagnostic,
    pushRequiredBaseConflictDiagnostic,
    pushRequiredBaseMismatchDiagnostic
} from "./consumer-diagnostics.js"
import {
    collectMixinClassDiagnostics
} from "./mixin-diagnostics.js"
import {
    localMixinHeritageTypes,
    localMixinRefs
} from "./mixin-refs.js"
import { deriveLinearizationPlan, linearizeDependencies, type LinearizationPlanSlice } from "./linearization.js"
import {
    createMixinConstructionNewType,
    positionConstructionConfigAlias
} from "./construction-config.js"
import { isConstructionBaseOptIn } from "./construction-chain.js"
import { buildImportedNameMap } from "./import-map.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import { cloneNode, hasModifier } from "./util.js"
import { generatedTextRange, preserveTextRange } from "./text-range.js"
import type { TypeScript } from "./util.js"
import { asMixinFactory, createMixinFactoryExpression, createMixinValueCastType, exportModifiersOf, interfaceHeritageClauses } from "./mixin-factory.js"
import { constructionDependencyRefs, createMixinDecorateCallback, expandSourceViewMixinClass } from "./mixin-source-view.js"

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
        tsInstance,
        sourceFile,
        base.expression,
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
            tsInstance,
            sourceFile,
            diagnostic.node,
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
    const dependencyHeritage     = localMixinHeritageTypes(tsInstance, declaration, context)
    const dependencyRefs         = localMixinRefs(tsInstance, context, dependencyHeritage)
    const linearizationConflict  = mixinLinearizationConflict(context, dependencyRefs)
    const declaredRequiredBase   = requiredBaseType(tsInstance, declaration)
    const requiredBaseResolution = context.crossFile?.requiredBases.resolveDirectRefs(
        sourceFile.fileName,
        // The mixin resolves its OWN ref with no use site: its type parameters stay
        // symbolic, so a dependency's `Base<T>` constraint composed through
        // `implements Dep<T>` compares equal to the mixin's own `extends Base<T>`.
        [ { ref, heritage: undefined } ]
    )

    if (linearizationConflict !== undefined && declaration.name !== undefined) {
        pushLinearizationConflictDiagnostic(
            tsInstance,
            sourceFile,
            context,
            dependencyHeritage[0] ?? declaration.name,
            linearizationDiagnosticMessage(dependencyRefs, context, linearizationConflict)
        )
    }

    if (requiredBaseResolution?.conflict !== undefined) {
        pushRequiredBaseConflictDiagnostic(
            tsInstance,
            sourceFile,
            context,
            dependencyHeritage[0] ?? declaration.name ?? declaration,
            requiredBaseResolution.conflict
        )
    }

    // Reported ONLY when the mismatch was produced by THIS mixin's own `extends` — a
    // dependency's mismatch propagates through the resolution (it correctly blocks base
    // selection) but is diagnosed once, on the dependency itself (REVIEW finding 7).
    if (requiredBaseResolution?.explicitMismatch !== undefined && declaredRequiredBase !== undefined &&
        context.crossFile?.requiredBases.ownsMismatch(
            sourceFile.fileName,
            declaration.pos,
            requiredBaseResolution.explicitMismatch
        ) === true
    ) {
        pushRequiredBaseMismatchDiagnostic(
            tsInstance,
            sourceFile,
            context,
            declaredRequiredBase,
            ref.className,
            requiredBaseResolution.explicitMismatch.actual.baseDisplayName,
            requiredBaseResolution.explicitMismatch.required
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
    const requiredBase   = declaredRequiredBase
    // Approach (B): precompute this mixin's requirement linearization as a merge plan the
    // runtime replays instead of running C3. Absent for a dependency-free mixin (no merge)
    // and for a conflicting requirement set (the conflict is reported above) -- the runtime
    // falls back to C3 in those cases.
    const linearizationPlan      = linearizationConflict !== undefined || dependencyRefs.length === 0
        ? undefined
        : deriveLinearizationPlan(dependencyRefs.map((dependencyRef) => dependencyRef.key), context)
    const linearizedDependencies = requiredBase === undefined && linearizationPlan !== undefined
        ? linearizeDependencies(dependencyRefs.map((dependencyRef) => dependencyRef.key), context)
        : []
    const planSelection          = requiredBase === undefined && linearizationPlan !== undefined
        ? context.crossFile?.requiredBases.planSelection(
            sourceFile.fileName,
            linearizedDependencies,
            requiredBaseResolution
        )
        : undefined
    // Same three shapes as the consumer emit (REVIEW finding 1): a selected index, a
    // syntactically-verified `0` ("known unconstrained"), or NO plan — the runtime
    // required-base scan resolves whatever the compile side could not decide.
    const requiredBasePlan = requiredBase !== undefined || linearizationPlan === undefined
        ? undefined
        : planSelection?.selectedRef !== undefined
            ? planSelection.plan
            : linearizedDependencies.some((dependencyRef) => hasSyntacticRequiredBase(tsInstance, dependencyRef))
                ? undefined
                : 0

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
            tsInstance,
            sourceFile,
            requiredBase,
            options,
            facts,
            new Set(),
            context.crossFile,
            baseImportMap
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
        baseImportMap,
        context.nativeDiagnostics,
        context.usedFactoryImports
    )

    const interfaceDeclaration = preserveTextRange(
        tsInstance,
        factory.createInterfaceDeclaration(
            exportModifiers,
            ref.className,
            typeParameters,
            interfaceHeritageClauses(tsInstance, declaration, context),
            interfaceMembers
        ),
        interfaceDeclarationRange(declaration, interfaceMembers)
    )

    const factoryStatement = preserveTextRange(
        tsInstance,
        factory.createVariableStatement(
            factoryExportModifiers,
            factory.createVariableDeclarationList(
                [
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
                ],
                tsInstance.NodeFlags.Const
            )
        ),
        generatedTextRange(sourceFile, declaration.end)
    )

    const valueStatement = preserveTextRange(
        tsInstance,
        factory.createVariableStatement(
            exportModifiers,
            factory.createVariableDeclarationList(
                [
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
                                        createMixinDecorateCallback(tsInstance, sourceFile, declaration, ref, options),
                                        requiredBasePlan
                                    )
                                ),
                                factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword)
                            ),
                            createMixinValueCastType(tsInstance, declaration, ref, typeParameters, constructionNew?.newType)
                        )
                    )
                ],
                tsInstance.NodeFlags.Const
            )
        ),
        generatedTextRange(sourceFile, declaration.end)
    )

    const defaultExportStatement = defaultExport
        ? [ preserveTextRange(
            tsInstance,
            factory.createExportAssignment(
                undefined,
                undefined,
                factory.createIdentifier(ref.className)
            ),
            generatedTextRange(sourceFile, declaration.end)
        ) ]
        : []

    const configAliasStatement = [ constructionNew?.configAlias, constructionNew?.configMeta ]
        .filter((companion): companion is ts.TypeAliasDeclaration => companion !== undefined)
        .map((companion) => positionConstructionConfigAlias(
            tsInstance,
            companion,
            generatedTextRange(sourceFile, declaration.end),
            declaration
        ))

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
    decorateCallback: ts.Expression | undefined,
    requiredBasePlan: number | undefined
): ts.Expression[] {
    const factory                                 = tsInstance.factory
    const explicitUndefined                       = (): ts.Expression => factory.createIdentifier("undefined")
    const trailing: (ts.Expression | undefined)[] = [
        requiredBase === undefined ? undefined : cloneNode(tsInstance, requiredBase.expression),
        linearizationPlan === undefined ? undefined : createLinearizationPlanLiteral(tsInstance, linearizationPlan),
        linearizationPlan === undefined ? undefined : factory.createStringLiteral(mode),
        decorateCallback,
        requiredBasePlan === undefined ? undefined : factory.createNumericLiteral(requiredBasePlan)
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
// Whether the ref carries a required base SYNTACTICALLY (its declaration's `extends`, or
// the registry/.d.ts marker) — a pure check, unlike `requiredBaseTypeOfRef`, which also
// registers the base's import. Used to verify a "known unconstrained" plan `0`: when any
// dependency names a base the resolver could not place, the plan degrades to the runtime
// scan instead of asserting an Empty root.
function hasSyntacticRequiredBase(tsInstance: TypeScript, ref: ResolvedMixinRef): boolean {
    return ref.declaration !== undefined
        ? requiredBaseType(tsInstance, ref.declaration) !== undefined
        : ref.requiredBase !== undefined
}

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
