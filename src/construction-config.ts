import type * as ts from "typescript"
import {
    intersectionOrSingle,
    MixinTransformError,
    rewriteTypeReferences
} from "./expand-util.js"
import { dottedExpressionText, dottedNameToEntityName, dottedNameToExpression } from "./entity-name.js"
import {
    type ImportMap,
    mixinDiagnosticCode,
    nativeDiagnosticOn,
    registryKeyFileName,
    transplantableConfigProperties,
    uniqueConfigProperties,
    type ConfigProperty,
    type CrossFileContext,
    type NativeMixinDiagnostic,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { baseConfigProperties, isConstructionBaseOptIn, resolveCrossFileConstructionBase } from "./construction-chain.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import { deepCloneNode, hasModifier, stripVarianceAnnotations } from "./util.js"
import { collapseSubtreeTextRange, preserveGeneratedDeclarationRange, preserveTextRange } from "./text-range.js"
import type { TypeScript } from "./util.js"

type ConstructionConfig = {
    type              : ts.TypeNode,
    optionalParameter : boolean,
    // The aggregated property list the config type was built from — the single source the
    // `<Name>ConfigMeta` companion derives its literal unions from, so meta ↔ config
    // coherence holds by construction.
    properties        : ConfigProperty[]
}

// A short, improbable marker placed as the first statement of the generated `static new`
// implementation body (`void "$tmc$"`). It survives the emit-path reprint+reparse (real code,
// not a comment, so `removeComments` cannot drop it) and is what the JS-emit strip transformer
// (`stripGeneratedStaticNew` in index.ts) matches to drop the runtime-redundant factory.
// Correctness rests on the exact `void "$tmc$"` shape, not the string length, so it is kept
// short (a faster `indexOf` file gate); the only cost of a coincidental match elsewhere is a
// skipped fast-path, never a wrong strip. Declaration emit keeps the typed `static new`.
export const generatedStaticNewMarker = "$tmc$"


// The generated construction members for a class: the `static new` overloads plus
// the exported `<ClassName>Config` type alias they reference. The alias is a sibling
// top-level declaration, so the caller (which owns the surrounding statement list and
// its positioning) inserts and positions it; `configAlias` is undefined when the
// class is not a construction base.
export type ConstructionMembers = {
    members     : ts.ClassElement[],
    configAlias : ts.TypeAliasDeclaration | undefined,
    // The `<ClassName>ConfigMeta` companion — emit plane only (undefined in source view,
    // when the class is not a construction base, and in the reserved-name error state).
    configMeta  : ts.TypeAliasDeclaration | undefined
}

export function createConstructionMembers(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    options: TransformOptions,
    generatedRange: ts.TextRange,
    crossFile?: CrossFileContext,
    baseImportMap?: ImportMap,
    requiredBaseIsConstructionBase = false,
    nativeDiagnostics?: NativeMixinDiagnostic[]
): ConstructionMembers {
    const facts = getSourceFileFacts(tsInstance, sourceFile, options)

    // An ABSTRACT class gets NO generated factory: a `static new` member would make the
    // abstract class constructible. With none generated, an `AbstractModel.new(...)` call
    // resolves to the inherited `Base.new`, whose concrete-constructor `this` parameter
    // rejects the abstract static side (§7.26); a concrete subclass generates its own
    // typed factory (with the full accumulated config) as usual.
    if (declaration.name === undefined ||
        hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.AbstractKeyword) ||
        facts.classesByDeclaration.get(declaration)?.hasStaticNew === true ||
        !(
            requiredBaseIsConstructionBase ||
            isConstructionBaseOptIn(
                tsInstance,
                sourceFile,
                extendsType ?? implicitRequiredBase,
                options,
                facts,
                new Set(),
                crossFile,
                baseImportMap
            )
        )
    ) {
        return { members: [], configAlias: undefined, configMeta: undefined }
    }

    const factory        = tsInstance.factory
    const staticModifier = [ factory.createToken(tsInstance.SyntaxKind.StaticKeyword) ]
    const config         = createConstructionConfig(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        implicitRequiredBase,
        mixinRefs,
        options,
        facts,
        crossFile,
        baseImportMap
    )
    const consumerType   = createConsumerInstanceType(tsInstance, declaration)

    // Expose the config as an exported, named `<ClassName>Config` alias (carrying the
    // class's own type parameters); the `new` param references it, so `.new(...)` type
    // errors read the clean alias name. The alias is reusable as a factory-parameter /
    // annotation type. (It is NOT a valid `initialize` override type - the base
    // `initialize` is all-optional; see the README.) The companion names are RESERVED: a
    // colliding user declaration is a TS990015 error, and the alias statement is then
    // skipped (its config inlines into the overload) so no raw TS2300 stacks on top.
    const aliasName                        = constructionConfigAliasName(declaration)
    const { configCollides, metaCollides } = reserveConfigCompanionNames(tsInstance, sourceFile, declaration, aliasName, nativeDiagnostics)

    banDefaultExportConstruction(tsInstance, sourceFile, declaration, nativeDiagnostics)

    const configAlias     = configCollides ? undefined : createConstructionConfigAlias(tsInstance, declaration, aliasName, config.type)
    const configReference = configCollides
        ? inlineConfigTypeClone(tsInstance, config.type)
        : createConfigAliasReference(tsInstance, declaration, aliasName)
    // The meta companion is EMIT-PLANE-ONLY (decision 4 of the pure-type-composition epic):
    // cross-package readers meet it in the emitted `.d.ts` (which both planes read as-is),
    // while same-program composition works from facts — so source view never carries it,
    // and a NON-exported class gets none either (nothing can import it, and the unused
    // module-local alias would be a TS6196 under `noUnusedLocals`).
    const configMeta = options.sourceView || metaCollides
        ? undefined
        : createConstructionConfigMeta(tsInstance, declaration, config, facts)

    // The checker validates overload adjacency by position (subsequent.pos ===
    // node.end), so source-view overloads get consecutive non-zero-width ranges:
    // zero width makes a node "missing" for the checker.
    const overloadRange = (index: number): ts.TextRange => options.sourceView
        ? { pos: generatedRange.pos + index, end: generatedRange.pos + index + 1 }
        : generatedRange

    const finishMember = (member: ts.ClassElement, index: number): ts.ClassElement => {
        // In source view, do NOT anchor the generated `static new` to the original
        // class via `setOriginalNode`. The source-view source file is built from a
        // throwaway clone that the program never binds; an `originalNode` pointing at
        // the (clone) class makes tsserver's go-to-definition / rename on a call like
        // `Mixin.new(...)` map the overload back to that unbound clone via
        // `getParseTreeNode` and crash in the checker ("Cannot read properties of
        // undefined (reading 'members')"). The construction members are fully
        // synthetic, so they need no original for declaration emit (unlike the
        // update-derived `$base`/value declarations), and their range is pinned
        // explicitly below. Emit keeps the original for source-map fidelity.
        if (options.sourceView) {
            const pinned = preserveTextRange(tsInstance, member, overloadRange(index))

            // Give the `new` name a resolvable, non-synthetic span. A FAILING `.new(...)`
            // call makes the checker elaborate the failure against the implementation
            // overload (`addImplementationSuccessElaboration`), computing an error span on
            // its name node. A factory-fresh name (pos/end = -1) trips `getErrorSpanForNode`
            // (`skipTrivia(-1)` overruns the node end → Debug.assert / TS #20809) and CRASHES
            // the compiler. Anchor it at the first overload's range — a real, non-trivia
            // source position — so the span resolves. (The method node keeps its own
            // per-overload range for the checker's overload-adjacency check.)
            if (tsInstance.isMethodDeclaration(pinned) && tsInstance.isIdentifier(pinned.name)) {
                preserveTextRange(tsInstance, pinned.name, overloadRange(0))
            }

            return pinned
        }

        // Pin the WHOLE member subtree (config type, return type, …) to the single
        // anchor, then set the original for source-map fidelity. A diagnostic on a node
        // *inside* the synthetic member (e.g. a perturbed config key in the `Pick<…>`)
        // otherwise has no source mapping of its own: the emit remap extrapolates its
        // column forward from the member anchor and caps it at the line end, landing one
        // column past the source-view position (which reads the anchor directly). With
        // the subtree collapsed, every interior node maps to the anchor, so both modes
        // agree on the column too.
        collapseSubtreeTextRange(tsInstance, member, overloadRange(index))

        return preserveGeneratedDeclarationRange(tsInstance, member, overloadRange(index), declaration)
    }

    // The generic overload's type parameters are `deepCloneNode`d from the class,
    // so they keep their source positions while the method itself is pinned to a
    // tiny synthetic overload range — those stranded identifiers crash tsserver's
    // getChildren (invariant #5). Collapse just the clones to a synthetic range
    // (`preserveTopLevelStatementRanges` then normalises them with the rest of the
    // method, gap-free); positions never affect typing. The clone keeps every other
    // child synthetic, so only the type parameters need this, and the second
    // (implementation) overload — all factory-fresh — is left untouched so the
    // checker's overload-success elaboration keeps a valid error span.
    const constructionTypeParameters = declaration.typeParameters === undefined
        ? undefined
        : factory.createNodeArray(declaration.typeParameters.map((typeParameter) => {
            const clone = deepCloneNode(tsInstance, typeParameter)

            if (options.sourceView) {
                collapseSubtreeTextRange(tsInstance, clone, { pos: -1, end: -1 })
            }

            return clone
        }))

    const members = [
        finishMember(
            factory.createMethodDeclaration(
                staticModifier,
                undefined,
                "new",
                undefined,
                constructionTypeParameters,
                [ factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    "props",
                    config.optionalParameter ? factory.createToken(tsInstance.SyntaxKind.QuestionToken) : undefined,
                    configReference
                ) ],
                consumerType,
                undefined
            ),
            0
        ),
        // The implementation overload (never visible to callers; the typed overload above is
        // what they resolve to). Its parameter MUST stay `any`, not `unknown`: the body
        // forwards `props` to `super.new(props)`, and in a construction *subclass* `super.new`
        // resolves to the PARENT's typed overload `new(props: ParentConfig)` — only `any` is
        // assignable to an arbitrary parent config (contravariantly); `unknown` is rejected
        // (TS2345). The return type is `unknown` (better than `any`): callers never see it,
        // and the body's `super.new(props)` (typed `Base`) is assignable to `unknown`.
        finishMember(
            factory.createMethodDeclaration(
                staticModifier,
                undefined,
                "new",
                undefined,
                undefined,
                [ factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    "props",
                    factory.createToken(tsInstance.SyntaxKind.QuestionToken),
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
                ) ],
                factory.createKeywordTypeNode(tsInstance.SyntaxKind.UnknownKeyword),
                factory.createBlock(
                    [
                        // Marker for the JS-emit strip transformer (see `generatedStaticNewMarker`).
                        factory.createExpressionStatement(
                            factory.createVoidExpression(factory.createStringLiteral(generatedStaticNewMarker))
                        ),
                        factory.createReturnStatement(factory.createCallExpression(
                            factory.createPropertyAccessExpression(
                                factory.createSuper(),
                                "new"
                            ),
                            undefined,
                            [ factory.createIdentifier("props") ]
                        ))
                    ],
                    true
                )
            ),
            1
        )
    ]

    return { members, configAlias, configMeta }
}

// Positions the generated `<ClassName>Config` alias, a sibling top-level statement the
// caller lists AFTER the class, collapsing the whole subtree to one real anchor at
// `declaration.end` - the gap just past the closing brace, OUTSIDE the class body, where the
// alias overlaps no sibling and no navigable user token. This anchor is load-bearing for
// EMIT; SOURCE VIEW supersedes the position - it appends the alias as REAL text past the file
// end and swaps in the reparsed node (`appendGeneratedConfigAliasesAsRealText`), so its
// source-view span comes from the tail, not from here. This call still sets the alias's
// `.original` (the class), which the append step uses to detect it. Two reasons for the exact
// anchor (both about emit; the tail handles source view):
//   - collapsing maps a perturbed config key that errors inside the alias body (e.g. TS2344)
//     to the anchor column, keeping emit parity-aligned with source view (the same trick the
//     construction `static new` members use); a `[-1,-1]` off-screen collapse would scatter
//     the diagnostic to an unrelated line; and
//   - being outside the class, it strands no identifier in trivia (invariant #5).
export function positionConstructionConfigAlias(
    tsInstance: TypeScript,
    alias: ts.TypeAliasDeclaration,
    generatedRange: ts.TextRange,
    declaration: ts.ClassDeclaration
): ts.TypeAliasDeclaration {
    const positioned = preserveGeneratedDeclarationRange(tsInstance, alias, generatedRange, declaration)

    collapseSubtreeTextRange(tsInstance, positioned, generatedRange)

    return positioned
}

// The emit-path counterpart of the construction members for a mixin: the value-cast
// `new` signature plus the exported `<MixinName>Config` alias it references. The alias
// is a sibling top-level statement the caller positions and emits.
export type MixinConstructionNew = {
    newType     : ts.TypeNode,
    // Undefined when the reserved `<MixinName>Config` name collides with a user
    // declaration (TS990015): the `new` signature then inlines the config instead.
    configAlias : ts.TypeAliasDeclaration | undefined,
    // The `<MixinName>ConfigMeta` companion (this is the emit path — always generated
    // unless the reserved meta name collides).
    configMeta  : ts.TypeAliasDeclaration | undefined
}

// Construction `new` for a mixin's value type. A mixin that extends the package
// `Base` is construction-enabled, but unlike a consumer it has no class body to
// attach a generated `static new` to, so its value type otherwise inherits
// `Base.new`, which returns `Base` rather than the mixin's own instance type.
// This builds a `{ new(props?): Instance }` member that the value cast prepends
// so the mixin's standalone `.new(...)` resolves to the mixin type, alongside the
// named config alias it references. Returns undefined when the mixin is not a
// construction base.
export function createMixinConstructionNewType(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    options: TransformOptions,
    facts: SourceFileFacts,
    crossFile?: CrossFileContext,
    baseImportMap?: ImportMap,
    nativeDiagnostics?: NativeMixinDiagnostic[]
): MixinConstructionNew | undefined {
    if (declaration.name === undefined ||
        facts.classesByDeclaration.get(declaration)?.hasStaticNew === true ||
        !isConstructionBaseOptIn(tsInstance, sourceFile, extendsType, options, facts, new Set(), crossFile, baseImportMap)
    ) {
        return undefined
    }

    const factory = tsInstance.factory
    const config  = createConstructionConfig(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        undefined,
        mixinRefs,
        options,
        facts,
        crossFile,
        baseImportMap
    )
    // A construction-base mixin is just a class for config purposes, so it gets the
    // same exported `<MixinName>Config` alias - emitted in both the value-cast (emit)
    // and the `static new` (source view) forms so the symbol exists in both.
    const aliasName                        = constructionConfigAliasName(declaration)
    const { configCollides, metaCollides } = reserveConfigCompanionNames(tsInstance, sourceFile, declaration, aliasName, nativeDiagnostics)

    banDefaultExportConstruction(tsInstance, sourceFile, declaration, nativeDiagnostics)

    // A method signature with a STRING-LITERAL name (`"new"(props?): Instance`), not a
    // property (`new: (props?) => Instance`): a method's parameters are checked
    // bivariantly, so a subclass that `extends` this mixin and adds a required config
    // field still has an assignable `static new` (a property's function type is checked
    // contravariantly under `strictFunctionTypes`, which rejects it - TS2417). The name
    // must be a string literal because a bare `new(...)` in a type literal parses as a
    // construct signature; `"new"(...)` parses as a callable `.new` method.
    // A GENERIC mixin's `.new` declares its OWN type parameters mirroring the class's
    // (`"new"<T>(props?: RepoConfig<T>): Repo<T>` — explicit or inferred from props), cloned
    // deep (no shared source positions) with variance annotations stripped (a signature
    // position — TS1274).
    return {
        newType : factory.createTypeLiteralNode([
            factory.createMethodSignature(
                undefined,
                factory.createStringLiteral("new"),
                undefined,
                declaration.typeParameters?.map((typeParameter) =>
                    stripVarianceAnnotations(tsInstance, deepCloneNode(tsInstance, typeParameter))),
                [ factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    "props",
                    config.optionalParameter ? factory.createToken(tsInstance.SyntaxKind.QuestionToken) : undefined,
                    configCollides
                        ? inlineConfigTypeClone(tsInstance, config.type)
                        : createConfigAliasReference(tsInstance, declaration, aliasName)
                ) ],
                createConsumerInstanceType(tsInstance, declaration)
            )
        ]),
        configAlias : configCollides
            ? undefined
            : createConstructionConfigAlias(tsInstance, declaration, aliasName, config.type),
        configMeta : options.sourceView || metaCollides
            ? undefined
            : createConstructionConfigMeta(tsInstance, declaration, config, facts)
    }
}

function createConstructionConfig(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    // Currently unused: the construction config has a single (public-only) shape
    // since the `instance-type` mode was removed. Kept threaded so a future mode
    // option can be honored here without re-plumbing every caller.
    options: TransformOptions,
    facts: SourceFileFacts,
    crossFile?: CrossFileContext,
    baseImportMap?: ImportMap
): ConstructionConfig {
    const factory = tsInstance.factory

    const properties                  = staticConstructionConfigProperties(
        tsInstance,
        sourceFile,
        declaration,
        extendsType,
        implicitRequiredBase,
        mixinRefs,
        facts,
        crossFile,
        baseImportMap
    )
    const opaque                      = declarationFileConfigParts(
        tsInstance,
        declaration,
        extendsType ?? implicitRequiredBase,
        mixinRefs,
        crossFile,
        baseImportMap
    )
    const requiredKeys: ts.TypeNode[] = []
    const optionalKeys: ts.TypeNode[] = []
    // Settable accessors that carry a setter type are emitted as explicit members (typed by
    // the setter, not the getter a `Pick` would read); everything else goes through `Pick`.
    // Class index signatures ride the same explicit literal as cloned index members, so a
    // config object's bag keys stay value-constrained.
    const explicitMembers: ts.TypeElement[] = []

    for (const property of properties) {
        if (property.valueType !== undefined) {
            explicitMembers.push(factory.createPropertySignature(
                undefined,
                configPropertyName(tsInstance, property),
                property.optional ? factory.createToken(tsInstance.SyntaxKind.QuestionToken) : undefined,
                deepCloneNode(tsInstance, property.valueType)
            ))
        } else if (property.optional) {
            optionalKeys.push(configKeyType(tsInstance, property))
        } else {
            requiredKeys.push(configKeyType(tsInstance, property))
        }
    }

    for (const indexSignature of facts.classesByDeclaration.get(declaration)?.indexSignatures ?? []) {
        explicitMembers.push(deepCloneNode(tsInstance, factory.createIndexSignature(
            undefined,
            indexSignature.parameters,
            indexSignature.type
        )))
    }

    const consumerType = createConsumerInstanceType(tsInstance, declaration)
    const requiredType = requiredKeys.length === 0
        ? undefined
        : factory.createTypeReferenceNode("Pick", [
            consumerType,
            keyUnionType(tsInstance, requiredKeys)
        ])
    const optionalType = optionalKeys.length === 0
        ? undefined
        : factory.createTypeReferenceNode("Partial", [
            factory.createTypeReferenceNode("Pick", [
                consumerType,
                keyUnionType(tsInstance, optionalKeys)
            ])
        ])
    const explicitType = explicitMembers.length === 0
        ? undefined
        : factory.createTypeLiteralNode(explicitMembers)

    // Explicit accessor members are always optional, so they never force a required param.
    const parts = ([ requiredType, optionalType, explicitType, ...opaque.types ] as Array<ts.TypeNode | undefined>).filter(
        (part): part is ts.TypeNode => part !== undefined
    )

    // An EMPTY config must stay EXACT: `Partial<Pick<C, never>>` reduces to `{}`, which
    // accepts EVERY object (excess-property checking has nothing to check against), so an
    // unknown key would silently pass. `Partial<Record<PropertyKey, never>>` keeps `.new()`
    // and `.new({})` legal while typing every possible key `never` — any supplied key is a
    // type error (§7.25).
    if (parts.length === 0) {
        return {
            type : factory.createTypeReferenceNode("Partial", [
                factory.createTypeReferenceNode("Record", [
                    factory.createTypeReferenceNode("PropertyKey", undefined),
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
                ])
            ]),
            optionalParameter : true,
            properties        : []
        }
    }

    return {
        type              : flattenIfIntersection(tsInstance, parts),
        // A `.d.ts` contributor whose PUBLISHED `.new` parameter is required may owe that
        // requiredness to keys the fact transport cannot respell (computed/symbol) — the
        // opaque flag keeps this `.new`'s parameter required in that case.
        optionalParameter : requiredType === undefined && !opaque.requiresArgument,
        properties
    }
}

// §13.8 — the VALUE-ROUTE config carrier for DECLARATION-file contributors. A published
// construction mixin/base carries its FULL config type on its `"new"(props: <Name>Config)`
// member — including COMPUTED const-string / unique-symbol keys and INDEX signatures, which
// the fact-based transport cannot respell in the consuming file (they are stripped by
// `transplantableConfigProperties`). The contributor's VALUE is already imported (it appears
// in the heritage), so `NonNullable<Parameters<(typeof V)["new"]>[0]>` names its exact
// published config with NO generated import — default exports included. It rides the config
// intersection alongside the respelled flat parts: duplicate keys intersect to the same
// types, and requiredness stays monotonic through the intersection. Boundaries: same-PROGRAM
// cross-file contributors stay fact-only (§10.25 — their transformed `"new"` is not a stable
// published surface), and a GENERIC use (`implements M<T>` / `extends B<T>`) is skipped —
// the value route cannot thread an instantiation.
function declarationFileConfigParts(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined
): { types: ts.TypeNode[], requiresArgument: boolean } {
    const factory              = tsInstance.factory
    const types: ts.TypeNode[] = []
    let requiresArgument       = false

    const valueRouteConfigType = (entityName: ts.EntityName): ts.TypeNode =>
        factory.createTypeReferenceNode("NonNullable", [
            factory.createIndexedAccessTypeNode(
                factory.createTypeReferenceNode("Parameters", [
                    factory.createIndexedAccessTypeNode(
                        factory.createParenthesizedType(factory.createTypeQueryNode(entityName)),
                        factory.createLiteralTypeNode(factory.createStringLiteral("new"))
                    )
                ]),
                factory.createLiteralTypeNode(factory.createNumericLiteral("0"))
            )
        ])

    for (const ref of mixinRefs) {
        if (ref.declaration !== undefined ||
            ref.localValueName === undefined ||
            ref.requiredBase?.isPackageBase !== true ||
            !registryKeyFileName(ref.key).endsWith(".d.ts") ||
            mixinImplementsTypeArguments(tsInstance, declaration, ref) !== undefined
        ) {
            continue
        }

        // A dependency's computed keys ride the DEPENDENT's published config (the emitted
        // `.new` param aggregates transitive dependencies), so only directly-referenced
        // (value-carrying) mixins contribute a part.
        types.push(valueRouteConfigType(dottedNameToEntityName(tsInstance, ref.localValueName)))

        if (crossFile?.registry.get(ref.key)?.configRequiresArgument === true) {
            requiresArgument = true
        }
    }

    if (baseType !== undefined && baseType.typeArguments === undefined) {
        const baseName  = tsInstance.isIdentifier(baseType.expression)
            ? baseType.expression.text
            : dottedExpressionText(tsInstance, baseType.expression)
        const baseEntry = baseName === undefined
            ? undefined
            : resolveCrossFileConstructionBase(baseName, crossFile, baseImportMap)

        if (baseEntry?.isBaseDescendant === true && baseEntry.fileName.endsWith(".d.ts")) {
            types.push(valueRouteConfigType(
                dottedNameToEntityName(tsInstance, baseName as string)
            ))

            if (baseEntry.configRequiresArgument === true) {
                requiresArgument = true
            }
        }
    }

    return { types, requiresArgument }
}

// A config that combines constituents (required `Pick`, optional `Partial<Pick>`, explicit
// accessor members) is structurally their intersection. But then a *failing* `.new(...)`
// diagnostic points at an inner constituent (`Pick<C, ...>`) instead of the config alias:
// TypeScript attaches the alias symbol only to the OUTERMOST type node (the one whose parent is
// the alias declaration), so an inner `Pick` keeps its own `Pick` alias and surfaces in the
// "...but required in type X" elaboration. Flattening the intersection through a single
// homomorphic mapped type (`{ [K in keyof T]: T[K] }`) yields one anonymous object type that IS
// the alias's whole target, so every elaboration names `<Class>Config`. Homomorphic-ness
// preserves each member's optionality and keeps the shape closed (excess-property-checked).
// A single constituent already carries the alias (its node's parent is the alias declaration),
// so it is returned untouched — no mapped type, no extra checker work in the common case.
function flattenIfIntersection(tsInstance: TypeScript, parts: ts.TypeNode[]): ts.TypeNode {
    const combined = intersectionOrSingle(tsInstance, parts)

    if (parts.length < 2) {
        return combined
    }

    const factory = tsInstance.factory

    return factory.createMappedTypeNode(
        undefined,
        factory.createTypeParameterDeclaration(
            undefined,
            factory.createIdentifier("K"),
            factory.createTypeOperatorNode(tsInstance.SyntaxKind.KeyOfKeyword, combined)
        ),
        undefined,
        undefined,
        factory.createIndexedAccessTypeNode(
            orphanSubtree(tsInstance, deepCloneNode(tsInstance, combined)),
            factory.createTypeReferenceNode("K", undefined)
        ),
        undefined
    )
}

// Drop every PARENT pointer of a `getSynthesizedDeepClone`d subtree. The clone keeps
// parents, and once the alias positioning stamps REAL ranges over the subtree, a parented,
// real-ranged literal satisfies the printer's "can use original text" test — a NUMERIC
// literal then prints as a SOURCE SLICE at its (foreign, zero-width-ish) range instead of
// its text (`Pick<C, }>`, the emit twin of invariant 10a's numeric branch; a string literal
// happens to re-quote from `.text`). Fresh factory nodes are parentless and always print
// from text — orphaning the clone restores exactly that behavior. Source view re-parents
// the whole transformed file afterwards, so nothing is lost there.
function orphanSubtree<Node extends ts.Node>(tsInstance: TypeScript, node: Node): Node {
    (node as { parent?: ts.Node }).parent = undefined

    tsInstance.forEachChild(node, (child) => {
        orphanSubtree(tsInstance, child)
    })

    return node
}

function staticConstructionConfigProperties(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    facts: SourceFileFacts,
    crossFile?: CrossFileContext,
    baseImportMap?: ImportMap
): ConfigProperty[] {
    // NEAREST-first (the `uniqueConfigProperties` contract): the class's own members, then
    // the applied mixins in linearization order, then the base chain — the nearest
    // declaration of a shared key chooses its config representation (§7.29).
    return uniqueConfigProperties([
        ...(facts.classesByDeclaration.get(declaration)?.configProperties ?? []),
        ...mixinRefs.flatMap((ref) => substituteMixinConfigTypeParameters(tsInstance, declaration, ref)),
        ...baseConfigProperties(tsInstance, sourceFile, extendsType ?? implicitRequiredBase, facts, crossFile, baseImportMap, new Set())
    ])
}

function keyUnionType(
    tsInstance: TypeScript,
    keys: ts.TypeNode[]
): ts.TypeNode {
    return keys.length === 1 ? keys[0] : tsInstance.factory.createUnionTypeNode(keys)
}

// The `Pick` key type of one config property: a NUMERIC literal for a numeric name
// (`keyof` yields `0`, never `"0"`, for a `public 0` / `public "0"` member), `typeof
// <entity>` for a computed key (const-string and unique-symbol keys alike), and a
// string literal otherwise.
function configKeyType(
    tsInstance: TypeScript,
    property: ConfigProperty
): ts.TypeNode {
    const factory = tsInstance.factory

    if (property.computedKeyName !== undefined) {
        return factory.createTypeQueryNode(dottedNameToEntityName(tsInstance, property.computedKeyName))
    }

    return /^\d+$/.test(property.name)
        ? factory.createLiteralTypeNode(factory.createNumericLiteral(property.name))
        : factory.createLiteralTypeNode(factory.createStringLiteral(property.name))
}

// An explicit config member's name: computed (`[field]`) for a computed key, a plain
// identifier/string-literal name otherwise.
function configPropertyName(
    tsInstance: TypeScript,
    property: ConfigProperty
): ts.PropertyName {
    const factory = tsInstance.factory

    if (property.computedKeyName !== undefined) {
        return factory.createComputedPropertyName(dottedNameToExpression(tsInstance, property.computedKeyName))
    }

    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property.name)
        ? factory.createIdentifier(property.name)
        : factory.createStringLiteral(property.name)
}

function createConsumerInstanceType(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ts.TypeReferenceNode {
    if (declaration.name === undefined) {
        throw new MixinTransformError(declaration.getSourceFile(), declaration, "A mixin consumer class must have a name")
    }

    return tsInstance.factory.createTypeReferenceNode(
        declaration.name.text,
        declaration.typeParameters?.map((typeParameter) => {
            return tsInstance.factory.createTypeReferenceNode(typeParameter.name.text, undefined)
        })
    )
}

// The generated, exported config-alias name for a construction class: always the plain
// `<ClassName>Config`. The companion names are RESERVED (see `reserveConfigCompanionNames`)
// so the name stays DERIVABLE from the class name alone — cross-file alias-route
// resolution never needs a discovery step. (Pre-epic behavior suffixed `_` until free —
// deleted with the reservation.)
function constructionConfigAliasName(declaration: ts.ClassDeclaration): string {
    return `${declaration.name?.text ?? ""}Config`
}

// The reserved companion-type names of a construction class — `<ClassName>Config` (the
// config alias) and `<ClassName>ConfigMeta` (the emit-plane metadata alias): a top-level
// user declaration or import binding colliding with either is a native TS990015 (the
// `static mix` reservation, §11.12, applied to the config type namespace). Reports which
// companion collided — the caller then skips that generated statement (the config alias
// inlines its type into the `static new` signature instead), so the only surfaced problem
// is the reservation diagnostic (emitting anyway would stack a raw TS2300 duplicate on
// top). Detection is unconditional (both planes must agree on the skipped statements);
// only the push needs the sink.
function reserveConfigCompanionNames(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    aliasName: string,
    nativeDiagnostics: NativeMixinDiagnostic[] | undefined
): { configCollides: boolean, metaCollides: boolean } {
    const declared  = collectTopLevelDeclaredNameNodes(tsInstance, sourceFile)
    const className = declaration.name?.text ?? ""

    const collides = (reservedName: string): boolean => {
        const collision = declared.get(reservedName)

        if (collision === undefined) {
            return false
        }

        nativeDiagnostics?.push(nativeDiagnosticOn(
            tsInstance,
            sourceFile,
            collision,
            mixinDiagnosticCode.ConstructionConfigNameReserved,
            `The name '${reservedName}' is reserved. ` +
                `ts-mixin-class generates a '${reservedName}' companion type next to the construction class '${className}'. ` +
                "Rename the colliding declaration."
        ))

        return true
    }

    return {
        configCollides : collides(aliasName),
        metaCollides   : collides(`${className}ConfigMeta`)
    }
}

// A DEFAULT-exported construction value is BANNED (pure-type-composition epic, decision 2):
// its `<Name>Config` companion cannot be exported (§7.15 keeps a default export's alias
// module-local, so the name does not leak), which is the one structural hole in
// companion-alias nameability — a downstream alias-route reference would have nothing to
// import. Generation still proceeds (the module-local alias keeps the class usable in its
// own file); the ban is the only surfaced problem. Default-exported NON-construction
// mixins never reach this (no companion is generated for them).
function banDefaultExportConstruction(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    nativeDiagnostics: NativeMixinDiagnostic[] | undefined
): void {
    if (nativeDiagnostics === undefined ||
        !hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword) ||
        !hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)
    ) {
        return
    }

    const className = declaration.name?.text ?? "<anonymous>"

    nativeDiagnostics.push(nativeDiagnosticOn(
        tsInstance,
        sourceFile,
        declaration.name ?? declaration,
        mixinDiagnosticCode.ConstructionDefaultExport,
        `A construction class cannot be default-exported. The generated '${className}Config' companion of ` +
            `class '${className}' must be exportable under a stable name, and a default export keeps it ` +
            "module-local. Use a named export."
    ))
}

function collectTopLevelDeclaredNameNodes(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Map<string, ts.Node> {
    const names = new Map<string, ts.Node>()

    // `set` only when unseen: the FIRST declaration is the diagnostic anchor. Generated
    // statements are skipped — a re-transform may see a previously generated alias
    // (synthetic positions, or a real-text appendee whose `.original` is the class) and
    // must not report the transform's own output as a user collision.
    const record = (name: string, node: ts.Node): void => {
        if (!names.has(name)) {
            names.set(name, node)
        }
    }

    for (const statement of sourceFile.statements) {
        if (statement.pos < 0 || tsInstance.isClassDeclaration(tsInstance.getOriginalNode(statement))) {
            continue
        }

        if ((tsInstance.isClassDeclaration(statement) ||
            tsInstance.isInterfaceDeclaration(statement) ||
            tsInstance.isTypeAliasDeclaration(statement) ||
            tsInstance.isEnumDeclaration(statement) ||
            tsInstance.isFunctionDeclaration(statement)) &&
            statement.name !== undefined
        ) {
            record(statement.name.text, statement.name)
        } else if (tsInstance.isVariableStatement(statement)) {
            for (const variable of statement.declarationList.declarations) {
                if (tsInstance.isIdentifier(variable.name)) {
                    record(variable.name.text, variable.name)
                }
            }
        } else if (tsInstance.isImportDeclaration(statement)) {
            collectImportNameNodes(tsInstance, statement.importClause, record)
        }
    }

    return names
}

function collectImportNameNodes(
    tsInstance: TypeScript,
    importClause: ts.ImportClause | undefined,
    record: (name: string, node: ts.Node) => void
): void {
    if (importClause === undefined) {
        return
    }

    if (importClause.name !== undefined) {
        record(importClause.name.text, importClause.name)
    }

    const namedBindings = importClause.namedBindings

    if (namedBindings === undefined) {
        return
    }

    if (tsInstance.isNamespaceImport(namedBindings)) {
        record(namedBindings.name.text, namedBindings.name)
        return
    }

    for (const element of namedBindings.elements) {
        record(element.name.text, element.name)
    }
}

// The `<ClassName>ConfigMeta` companion (pure-type-composition epic, decision 4): an
// exported, EMIT-PLANE-ONLY alias of LITERAL fields carrying the residual construction
// facts a downstream transform cannot re-derive from the config TYPE alone. Machine-
// readable by a trivial field/literal reader AND checker-addressable — the literal key
// unions plug straight into `Required<Pick<…>>` (the composition's re-require step).
// Derived from the SAME aggregated property list as the config type, so meta ↔ config
// coherence holds by construction. No type parameters: key sets and requiredness never
// depend on the class's generics.
function createConstructionConfigMeta(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    config: ConstructionConfig,
    facts: SourceFileFacts
): ts.TypeAliasDeclaration | undefined {
    const factory = tsInstance.factory

    // Only an EXPORTED class gets the meta: its sole consumer is a downstream package
    // reading the emitted `.d.ts`. A module-local (or default-exported — banned anyway)
    // class's meta could never be imported, and the dangling local alias would be a
    // TS6196 under `noUnusedLocals`.
    const exported = hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword)
        && !hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)

    if (!exported) {
        return undefined
    }

    const requiredKeys = config.properties.filter((property) => !property.optional)
        .map((property) => configKeyType(tsInstance, property))
    const keys         = config.properties.map((property) => configKeyType(tsInstance, property))
    // The index-signature KINDS (not keys): a downstream Omit gate must know a layer has a
    // `string`/`number`/`symbol` index signature, because `keyof`-based subtraction over
    // such a layer would erase deeper concrete keys (pre-probe 1's hazard).
    const indexKinds = (facts.classesByDeclaration.get(declaration)?.indexSignatures ?? [])
        .map((signature) => signature.parameters[0]?.type)
        .filter((type): type is ts.TypeNode => type !== undefined)
        .map((type) => factory.createLiteralTypeNode(factory.createStringLiteral(
            type.kind === tsInstance.SyntaxKind.NumberKeyword ? "number"
                : type.kind === tsInstance.SyntaxKind.SymbolKeyword ? "symbol"
                    : "string"
        )))

    const unionOrNever = (types: ts.TypeNode[]): ts.TypeNode => types.length === 0
        ? factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
        : keyUnionType(tsInstance, types)

    const literalField = (name: string, type: ts.TypeNode): ts.PropertySignature => factory.createPropertySignature(
        [ factory.createToken(tsInstance.SyntaxKind.ReadonlyKeyword) ],
        name,
        undefined,
        type
    )

    return factory.createTypeAliasDeclaration(
        [ factory.createToken(tsInstance.SyntaxKind.ExportKeyword) ],
        factory.createIdentifier(`${declaration.name?.text ?? ""}ConfigMeta`),
        undefined,
        factory.createTypeLiteralNode([
            literalField("requiresArgument", factory.createLiteralTypeNode(
                config.optionalParameter ? factory.createFalse() : factory.createTrue()
            )),
            literalField("requiredKeys", unionOrNever(requiredKeys)),
            literalField("keys", unionOrNever(keys)),
            literalField("indexKinds", unionOrNever(indexKinds))
        ])
    )
}

// The inline replacement for the alias reference in the RESERVED-name error state: a
// fresh, fully synthetic clone of the config type. Cloning detaches the (possibly
// real-positioned, setter-cloned) member type nodes, and the `-1` collapse both keeps
// source view free of stranded real positions inside the synthetic overload (invariant
// #5) and keeps the emit printer off source-slice reads for literals (invariant #10a).
function inlineConfigTypeClone(tsInstance: TypeScript, configType: ts.TypeNode): ts.TypeNode {
    const clone = deepCloneNode(tsInstance, configType)

    collapseSubtreeTextRange(tsInstance, clone, { pos: -1, end: -1 })

    return clone
}

// The typed `static new` overload's `props` parameter type. EMIT references the named
// alias (`<Name>Config`): emit reprints the file, so a failing `.new(...)` diagnostic reads
// the real "<Name>Config" source text. SOURCE VIEW cannot — the alias is synthetic, so
// TypeScript's alias display (`declarationNameToString` -> reads the name node's SOURCE
// TEXT) lands on the alias's anchor position (the class' `}`) and prints a meaningless `}`.
// So source view inlines the structural config type instead (no alias symbol -> the
// diagnostic EXPANDS to `Pick<Point, ...>` / `{ x: number; ... }`, whose member names come
// from symbols and so render position-independently). The clone's subtree is collapsed to a
// synthetic range: a settable-accessor config carries explicit member type nodes with real
// source positions (cloned from the setter), which would otherwise strand an identifier in
// the synthetic overload's trivia (invariant #5). The named alias is still emitted in both
// modes for user `initialize(config?: <Name>Config)` references.
function createConstructionConfigAlias(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    aliasName: string,
    configType: ts.TypeNode
): ts.TypeAliasDeclaration {
    const factory = tsInstance.factory

    // The alias's `export` tracks the class's own (same as the mixin factory's
    // `exportModifiersOf`): an exported class exposes `<Name>Config`; a module-local or
    // `export default` class keeps it local so an internal class does not leak the name.
    const exported = hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.ExportKeyword)
        && !hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword)

    return factory.createTypeAliasDeclaration(
        exported ? [ factory.createToken(tsInstance.SyntaxKind.ExportKeyword) ] : undefined,
        factory.createIdentifier(aliasName),
        // Clone the class type parameters so a generic class gets a generic alias
        // (`BoxConfig<T>`); reusing the originals would re-parent them in the binder.
        declaration.typeParameters?.map((typeParameter) => deepCloneNode(tsInstance, typeParameter)),
        configType
    )
}

function createConfigAliasReference(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    aliasName: string
): ts.TypeReferenceNode {
    return tsInstance.factory.createTypeReferenceNode(
        aliasName,
        declaration.typeParameters?.map((typeParameter) => {
            return tsInstance.factory.createTypeReferenceNode(typeParameter.name.text, undefined)
        })
    )
}

// A mixin's settable accessor whose setter type references the mixin's own type parameter
// (`set value(input: T | string)`) is collected with that raw `T` node. When the accessor
// flows into a consumer that fixes the parameter (`implements Boxed<number>`), the cloned
// setter type must substitute `T` -> the consumer's type argument (`number`); otherwise the
// generated `<Consumer>Config` references an unbound `T` (TS2304), breaking construction in
// BOTH emit and source-view. A parameter the consumer leaves unfixed falls back to its
// default (or `any`), so nothing dangles. Only LOCAL mixins carry the declaration (hence the
// type parameters) needed for this; an imported accessor has no available setter node and
// goes through `Pick` (a documented narrower limitation).
function substituteMixinConfigTypeParameters(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    ref: ResolvedMixinRef
): ConfigProperty[] {
    // An IMPORTED mixin's computed keys reference module-scoped consts/symbols of the
    // declaring file — unspellable here, so they leave the compile-time config.
    const configProperties = ref.declaration === undefined
        ? transplantableConfigProperties(ref.configProperties)
        : ref.configProperties
    const typeParameters   = ref.declaration?.typeParameters

    if (typeParameters === undefined || typeParameters.length === 0 ||
        configProperties.every((property) => property.valueType === undefined)) {
        return configProperties
    }

    const typeArguments = mixinImplementsTypeArguments(tsInstance, declaration, ref)
    const replacements  = new Map<string, ts.TypeNode>()

    typeParameters.forEach((typeParameter, index) => {
        replacements.set(
            typeParameter.name.text,
            typeArguments?.[index]
                ?? typeParameter.default
                ?? tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
        )
    })

    return configProperties.map((property) => property.valueType === undefined
        ? property
        : { ...property, valueType: substituteTypeReferences(tsInstance, property.valueType, replacements) })
}

// The type arguments the consumer supplies to `ref` in its `implements` clause
// (`implements Boxed<number>` -> `[number]`), matched by the mixin's local binding name.
function mixinImplementsTypeArguments(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    ref: ResolvedMixinRef
): ts.NodeArray<ts.TypeNode> | undefined {
    for (const clause of declaration.heritageClauses ?? []) {
        if (clause.token !== tsInstance.SyntaxKind.ImplementsKeyword) {
            continue
        }

        for (const type of clause.types) {
            const referenceText = tsInstance.isIdentifier(type.expression)
                ? type.expression.text
                : dottedExpressionText(tsInstance, type.expression)

            if (referenceText !== undefined &&
                (referenceText === ref.localValueName || referenceText === ref.className)) {
                return type.typeArguments
            }
        }
    }

    return undefined
}

// Replace every bare reference to a mapped type-parameter name inside `typeNode` with its
// replacement type (deep-cloned so the result is position-less and safe in both planes).
function substituteTypeReferences(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    replacements: Map<string, ts.TypeNode>
): ts.TypeNode {
    return rewriteTypeReferences(tsInstance, typeNode, (name) =>
        replacements.has(name) ? deepCloneNode(tsInstance, replacements.get(name)!) : undefined)
}
