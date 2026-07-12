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
import { getSourceFileFacts, type ClassFacts, type SourceFileFacts } from "./source-file-facts.js"
import { generatedName } from "./naming.js"
import { normalizePath } from "./util.js"
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
    nativeDiagnostics?: NativeMixinDiagnostic[],
    usedImports?: Map<string, { specifier: string, importedName: string, localName: string, typeOnly?: boolean }>
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
        baseImportMap,
        usedImports
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
    nativeDiagnostics?: NativeMixinDiagnostic[],
    usedImports?: Map<string, { specifier: string, importedName: string, localName: string, typeOnly?: boolean }>
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
        baseImportMap,
        usedImports
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

// One nearest-first layer of the composed construction config (the pure-type TREE — epic
// decision 1). A layer either JOINS BY REFERENCE (`<Name>Config<args>`: each level spells
// only its own keys and reuses the contributor's published alias) or FLATTENS its
// properties through the facts route: the class's own keys always, plus every contributor
// without a reachable alias — non-construction mixins, abstract / user-`static new` /
// reserved-name-colliding parents, and (until the cross-file alias-route stage) imported
// contributors.
type ConfigLayer = {
    reference  : { aliasName: string, typeArguments: ts.TypeNode[] | undefined } | undefined,
    properties : ConfigProperty[],
    // A reference layer whose keys are ALL overridden by nearer layers may be dropped
    // ONLY when `properties` is a COMPLETE inventory of the alias (a local, dependency-free
    // contributor without index signatures). An imported alias may carry cargo the fact
    // route cannot see (computed keys, index signatures) — it must stay referenced (bare,
    // or Omit-ed by its known keys) even when every known key is overridden.
    droppable? : boolean
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
    baseImportMap?: ImportMap,
    usedImports?: Map<string, { specifier: string, importedName: string, localName: string, typeOnly?: boolean }>
): ConstructionConfig {
    const factory = tsInstance.factory

    // The MERGED nearest-first property list (first-wins representation, MONOTONIC
    // requiredness — the `uniqueConfigProperties` contract). It stays the single source
    // for the meta companion, the `.new` parameter's requiredness, and each key's WINNING
    // representation; only the TYPE rendering below switched from re-spelling it to the
    // layered composition.
    const merged                = staticConstructionConfigProperties(
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
    const layers: ConfigLayer[] = [
        { reference: undefined, properties: facts.classesByDeclaration.get(declaration)?.configProperties ?? [] },
        ...mixinRefs.map((ref) => mixinConfigLayer(tsInstance, sourceFile, declaration, ref, options, facts, crossFile, baseImportMap, usedImports)),
        ...baseConfigLayer(tsInstance, sourceFile, extendsType ?? implicitRequiredBase, options, facts, crossFile, baseImportMap, usedImports)
    ]

    // A `.d.ts` contributor's published `.new` parameter may be REQUIRED for keys the fact
    // inventory misses (an older emit without the meta) — the registry flag keeps this
    // `.new`'s parameter required regardless of the carrier.
    const declarationRequiresArgument = declarationFileRequiresArgument(
        tsInstance,
        extendsType ?? implicitRequiredBase,
        mixinRefs,
        crossFile,
        baseImportMap
    )

    // Nearest-first winners: the FIRST layer declaring a key owns its rendering. A later
    // (deeper) layer renders only its unseen keys; a reference layer whose keys are all
    // owned by nearer layers contributes nothing and is dropped entirely (this also
    // absorbs the C3 duplication where a consumer lists both a mixin and its dependency —
    // the dependency's keys already ride the nearer mixin's composed alias).
    const winner = new Map<string, number>()

    layers.forEach((layer, index) => {
        for (const property of layer.properties) {
            if (!winner.has(property.name)) {
                winner.set(property.name, index)
            }
        }
    })

    const mergedByName         = new Map(merged.map((property) => [ property.name, property ]))
    const consumerType         = createConsumerInstanceType(tsInstance, declaration)
    const parts: ts.TypeNode[] = []

    // Consecutive facts layers coalesce into one Pick / Partial<Pick> / literal triple
    // (their keys are disjoint after the winner filter, and each key renders through its
    // MERGED representation, so ordering inside the group cannot change the result).
    let factsGroup: ConfigProperty[] = []

    const flushFactsGroup = (includeIndexSignatures: boolean): void => {
        parts.push(...renderFactsConfigParts(tsInstance, consumerType, factsGroup, includeIndexSignatures
            ? facts.classesByDeclaration.get(declaration)?.indexSignatures ?? []
            : []))
        factsGroup = []
    }

    let ownGroupFlushed = false

    layers.forEach((layer, index) => {
        const ownedKeys               = new Set<string>()
        const owned: ConfigProperty[] = []

        for (const property of layer.properties) {
            if (winner.get(property.name) === index && !ownedKeys.has(property.name)) {
                ownedKeys.add(property.name)
                owned.push(mergedByName.get(property.name) ?? property)
            }
        }

        if (layer.reference === undefined) {
            factsGroup.push(...owned)
            return
        }

        // The class's own index signatures ride the first (own) facts group even when the
        // own layer has no keyed properties.
        if (!ownGroupFlushed) {
            flushFactsGroup(true)
            ownGroupFlushed = true
        } else {
            flushFactsGroup(false)
        }

        if (owned.length === 0 && layer.droppable === true) {
            return
        }

        let referenceNode: ts.TypeNode = factory.createTypeReferenceNode(
            layer.reference.aliasName,
            layer.reference.typeArguments
        )

        // The OVERLAP GATE (pre-probe 2): subtract only the keys a NEARER layer actually
        // redeclared, spelled as a literal union — never `keyof`, whose `Exclude` would
        // distribute over the whole accumulated union (the instantiation quadratic).
        const overlapped       = layer.properties.filter((property) =>
            (winner.get(property.name) ?? index) < index)
        const overlappedUnique = [ ...new Map(overlapped.map((property) => [ property.name, property ])).values() ]

        if (overlappedUnique.length > 0) {
            referenceNode = factory.createTypeReferenceNode("Omit", [
                referenceNode,
                keyUnionType(tsInstance, overlappedUnique.map((property) =>
                    configKeyType(tsInstance, mergedByName.get(property.name) ?? property)))
            ])
        }

        parts.push(referenceNode)

        // The RE-REQUIRE (§7.28, overlap-gated too): this layer WINS a key it declares
        // optional, but a DEEPER layer requires it — requiredness is monotonic, so pull it
        // back with a `Required<Pick<…>>` on this layer's alias.
        const reRequired = owned.filter((property) => {
            const layerOwn = layer.properties.find((candidate) => candidate.name === property.name)

            return layerOwn?.optional === true && property.optional === false
        })

        if (reRequired.length > 0) {
            parts.push(factory.createTypeReferenceNode("Required", [
                factory.createTypeReferenceNode("Pick", [
                    factory.createTypeReferenceNode(layer.reference.aliasName, layer.reference.typeArguments),
                    keyUnionType(tsInstance, reRequired.map((property) => configKeyType(tsInstance, property)))
                ])
            ]))
        }
    })

    flushFactsGroup(!ownGroupFlushed)

    const allParts = parts

    // An EMPTY config must stay EXACT: `Partial<Pick<C, never>>` reduces to `{}`, which
    // accepts EVERY object (excess-property checking has nothing to check against), so an
    // unknown key would silently pass. `Partial<Record<PropertyKey, never>>` keeps `.new()`
    // and `.new({})` legal while typing every possible key `never` — any supplied key is a
    // type error (§7.25).
    if (allParts.length === 0) {
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
        type              : flattenIfIntersection(tsInstance, allParts),
        // Requiredness is MONOTONIC over the merged list (explicit accessor members never
        // force a required param — as before). A `.d.ts` contributor whose PUBLISHED
        // `.new` parameter is required may owe that requiredness to keys the fact
        // transport cannot respell (computed/symbol) — the opaque flag keeps this `.new`'s
        // parameter required in that case.
        optionalParameter : !merged.some((property) => property.valueType === undefined && !property.optional)
            && !declarationRequiresArgument,
        properties : merged
    }
}

// The Pick / Partial<Pick> / explicit-literal rendering of one flattened facts group —
// exactly the pre-composition shape, restricted to the group's properties. Settable
// accessors that carry a setter type are emitted as explicit members (typed by the
// setter, not the getter a `Pick` would read); everything else goes through `Pick`.
// Class index signatures ride the same explicit literal as cloned index members, so a
// config object's bag keys stay value-constrained.
function renderFactsConfigParts(
    tsInstance: TypeScript,
    consumerType: ts.TypeReferenceNode,
    properties: ConfigProperty[],
    indexSignatures: ts.IndexSignatureDeclaration[]
): ts.TypeNode[] {
    const factory                           = tsInstance.factory
    const requiredKeys: ts.TypeNode[]       = []
    const optionalKeys: ts.TypeNode[]       = []
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

    for (const indexSignature of indexSignatures) {
        explicitMembers.push(deepCloneNode(tsInstance, factory.createIndexSignature(
            undefined,
            indexSignature.parameters,
            indexSignature.type
        )))
    }

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

    return ([ requiredType, optionalType, explicitType ] as Array<ts.TypeNode | undefined>).filter(
        (part): part is ts.TypeNode => part !== undefined
    )
}

// A consumed mixin's config layer: joins by its `<MixinName>Config<args>` alias when that
// alias exists in this file (a LOCAL, construction-enabled mixin without a user
// `static new` and without a reserved-name collision — the use-site type arguments then
// instantiate the generic alias natively); otherwise flattens through the substituted
// fact route as before.
function mixinConfigLayer(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    ref: ResolvedMixinRef,
    options: TransformOptions,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    usedImports: Map<string, { specifier: string, importedName: string, localName: string, typeOnly?: boolean }> | undefined
): ConfigLayer {
    const mixinFacts = ref.declaration === undefined
        ? undefined
        : facts.classesByDeclaration.get(ref.declaration)

    // An IMPORTED contributor with an importable alias joins by a generated TYPE-ONLY
    // import (`import type { XConfig as __X$config } from …`). A GENERIC one needs the
    // use-site arguments — a transitive generic dependency (no implements entry) falls
    // back to the fact route, exactly like a contributor without an importable alias.
    if (mixinFacts === undefined && ref.configAliasImport !== undefined && usedImports !== undefined) {
        const typeArguments = mixinImplementsTypeArguments(tsInstance, declaration, ref)

        if (!ref.configAliasImport.generic || typeArguments !== undefined) {
            const localName = generatedName(ref.className, "$config")

            if (registerConfigAliasImport(usedImports, ref.configAliasImport.specifier, ref.configAliasImport.importedName, localName)) {
                return {
                    reference : {
                        aliasName     : localName,
                        typeArguments : typeArguments?.map((argument) => deepCloneNode(tsInstance, argument))
                    },
                    properties : ref.configProperties
                }
            }
        }
    }

    if (mixinFacts === undefined ||
        !localConfigAliasAvailable(tsInstance, sourceFile, mixinFacts, options, facts, crossFile, baseImportMap)
    ) {
        return { reference: undefined, properties: substituteMixinConfigTypeParameters(tsInstance, declaration, ref) }
    }

    return {
        reference : {
            aliasName     : `${mixinFacts.name ?? ""}Config`,
            typeArguments : aliasReferenceTypeArguments(tsInstance, declaration, ref, mixinFacts)
        },
        // Identity only (overlap / winner gates): the alias itself carries the types.
        properties : ref.configProperties,
        // Complete inventory: local and no index signatures — only then may a
        // fully-overridden layer drop. Dependencies are irrelevant here: the consumer's
        // C3-linearized ref list carries every transitive dependency as its OWN layer,
        // so their cargo never rides only through this alias.
        droppable  : mixinFacts.indexSignatures.length === 0
    }
}

// The direct parent's config layer: joins by `<ParentName>Config<args>` when the parent is
// a LOCAL class with an available alias (the parent's alias already accumulates ITS whole
// chain — this is what makes the composition a TREE); otherwise flattens the accumulated
// base-chain facts as before. Returned as a list so a missing base contributes nothing.
function baseConfigLayer(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    options: TransformOptions,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    usedImports: Map<string, { specifier: string, importedName: string, localName: string, typeOnly?: boolean }> | undefined
): ConfigLayer[] {
    if (baseType === undefined) {
        return []
    }

    const accumulated = () => baseConfigProperties(tsInstance, sourceFile, baseType, facts, crossFile, baseImportMap, new Set())
    const flattened   = (): ConfigLayer[] => {
        const properties = accumulated()

        return properties.length === 0 ? [] : [ { reference: undefined, properties } ]
    }

    if (!tsInstance.isIdentifier(baseType.expression)) {
        return flattened()
    }

    const parentFacts = facts.classesByName.get(baseType.expression.text)

    // An IMPORTED parent with an importable alias joins by a generated type-only import;
    // the extends clause's own type arguments instantiate it (a bare generic parent falls
    // back to its defaults natively).
    if (parentFacts === undefined) {
        const baseName  = baseType.expression.text
        const baseEntry = resolveCrossFileConstructionBase(baseName, crossFile, baseImportMap)
        const specifier = facts.imports.find((importFacts) => importFacts.localNames.includes(baseName))?.specifier
        const binding   = baseImportMap?.get(baseName)

        // The declaring-module check mirrors the mixin route: a named re-export barrel
        // forwards the class value but not its `<Name>Config` alias.
        if (baseEntry?.configAliasAvailable === true && specifier !== undefined && usedImports !== undefined &&
            binding !== undefined && normalizePath(binding.resolvedFileName) === normalizePath(baseEntry.fileName)
        ) {
            const localName = generatedName(baseEntry.name, "$config")

            if (registerConfigAliasImport(usedImports, specifier, `${baseEntry.name}Config`, localName)) {
                return [ {
                    reference : {
                        aliasName     : localName,
                        typeArguments : baseType.typeArguments === undefined
                            ? undefined
                            : baseType.typeArguments.map((argument) => deepCloneNode(tsInstance, argument))
                    },
                    properties : accumulated()
                } ]
            }
        }

        return flattened()
    }

    if (!localConfigAliasAvailable(tsInstance, sourceFile, parentFacts, options, facts, crossFile, baseImportMap)) {
        return flattened()
    }

    return [ {
        reference : {
            aliasName     : `${parentFacts.name ?? ""}Config`,
            typeArguments : baseType.typeArguments === undefined
                ? undefined
                : baseType.typeArguments.map((argument) => deepCloneNode(tsInstance, argument))
        },
        properties : accumulated()
    } ]
}

// Whether a class's `<Name>Config` alias is importable FROM ANOTHER FILE, short of
// construction-enabledness — the registration-side twin of `localConfigAliasAvailable`
// with the export requirement on top (the alias's export tracks the class's, §7.15).
// Recorded on registry entries at build time so a downstream file can decide the alias
// route without re-reading the declaring file. The construction-base registry combines
// this with its own `isBaseDescendant` resolution; the mixin registry adds the LOCAL
// construction check below.
export function exportedConfigAliasEligible(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    classFacts: ClassFacts
): boolean {
    return classFacts.name !== undefined &&
        // Statement-list membership, not `declaration.parent` — see `localConfigAliasAvailable`.
        sourceFile.statements.includes(classFacts.declaration) &&
        hasModifier(tsInstance, classFacts.declaration, tsInstance.SyntaxKind.ExportKeyword) &&
        !hasModifier(tsInstance, classFacts.declaration, tsInstance.SyntaxKind.DefaultKeyword) &&
        !hasModifier(tsInstance, classFacts.declaration, tsInstance.SyntaxKind.AbstractKeyword) &&
        !classFacts.hasStaticNew &&
        !collectTopLevelDeclaredNameNodes(tsInstance, sourceFile).has(`${classFacts.name}Config`)
}

// The mixin-registry variant: eligibility plus LOCAL construction-enabledness (no
// cross-file context exists at registration — a mixin whose base chain leaves the file
// just keeps the fact route, which is always correct).
export function exportedConfigAliasAvailable(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    classFacts: ClassFacts,
    options: TransformOptions,
    facts: SourceFileFacts
): boolean {
    return exportedConfigAliasEligible(tsInstance, sourceFile, classFacts) &&
        isConstructionBaseOptIn(
            tsInstance,
            sourceFile,
            classFacts.extendsType,
            options,
            facts,
            new Set(),
            undefined,
            undefined
        )
}

// Registers one generated type-only alias import (`import type { XConfig as __X$config }
// from "<specifier>"`) on the shared per-file import map — the same rails the mixin
// factory imports materialize through. Returns false (caller falls back to the fact
// route) when a DIFFERENT module already claimed the local name: two same-named
// contributors from two modules cannot share `__X$config`.
function registerConfigAliasImport(
    usedImports: Map<string, { specifier: string, importedName: string, localName: string, typeOnly?: boolean }>,
    specifier: string,
    importedName: string,
    localName: string
): boolean {
    const key = `${specifier}:${importedName}:${localName}`

    if (usedImports.has(key)) {
        return true
    }

    for (const existing of usedImports.values()) {
        if (existing.localName === localName && existing.specifier !== specifier) {
            return false
        }
    }

    usedImports.set(key, { specifier, importedName, localName, typeOnly: true })

    return true
}

// Whether a LOCAL class publishes a `<Name>Config` alias this file can reference: named,
// concrete (an abstract class generates no construction members), no user-owned
// `static new` (it suppresses generation), construction-enabled through its own extends
// chain, and its reserved alias name not taken by a user declaration (the TS990015 error
// state skips the alias). Conservative by design — a MISS only means the layer flattens
// through facts, which is always correct.
function localConfigAliasAvailable(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    classFacts: ClassFacts,
    options: TransformOptions,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined
): boolean {
    return classFacts.name !== undefined &&
        // The alias is spliced as a SIBLING of the contributor's declaration; only a
        // top-level contributor's alias is lexically reachable from an arbitrary
        // reference site (a namespace/nested contributor's alias lives inside its block).
        // Membership in the file's own statement list, NOT `declaration.parent` — the
        // registry builds before the binder runs, when parent pointers are still unset.
        sourceFile.statements.includes(classFacts.declaration) &&
        !hasModifier(tsInstance, classFacts.declaration, tsInstance.SyntaxKind.AbstractKeyword) &&
        !classFacts.hasStaticNew &&
        isConstructionBaseOptIn(
            tsInstance,
            sourceFile,
            classFacts.extendsType,
            options,
            facts,
            new Set(),
            crossFile,
            baseImportMap
        ) &&
        !collectTopLevelDeclaredNameNodes(tsInstance, sourceFile).has(`${classFacts.name}Config`)
}

// The FULL type-argument list for a generic contributor's alias reference, mirroring the
// substitution fallback (`substituteMixinConfigTypeParameters`): the use-site argument,
// else the parameter's default, else `any` — spelled explicitly so a partial use never
// leaves the alias under-applied (TS2314).
function aliasReferenceTypeArguments(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    ref: ResolvedMixinRef,
    mixinFacts: ClassFacts
): ts.TypeNode[] | undefined {
    const typeParameters = mixinFacts.declaration.typeParameters

    if (typeParameters === undefined || typeParameters.length === 0) {
        return undefined
    }

    const typeArguments = mixinImplementsTypeArguments(tsInstance, declaration, ref)

    return typeParameters.map((typeParameter, index) => {
        const argument = typeArguments?.[index] ?? typeParameter.default

        return argument === undefined
            ? tsInstance.factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword)
            : deepCloneNode(tsInstance, argument)
    })
}

// The `.d.ts` parameter-requiredness sweep — all that remains of the §13.8 VALUE ROUTE
// (`NonNullable<Parameters<(typeof V)["new"]>[0]>`), which the pure-type composition's
// alias route replaced wholesale (epic decision 1; the alias carries the FULL published
// config, generics included). A published contributor's `.new` parameter may be REQUIRED
// for keys the downstream fact inventory misses (an older emit without the meta), so the
// registry flag is still honored for every `.d.ts` contributor, routed or not.
function declarationFileRequiresArgument(
    tsInstance: TypeScript,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined
): boolean {
    for (const ref of mixinRefs) {
        if (ref.declaration === undefined &&
            registryKeyFileName(ref.key).endsWith(".d.ts") &&
            crossFile?.registry.get(ref.key)?.configRequiresArgument === true
        ) {
            return true
        }
    }

    if (baseType === undefined) {
        return false
    }

    const baseName = tsInstance.isIdentifier(baseType.expression)
        ? baseType.expression.text
        : dottedExpressionText(tsInstance, baseType.expression)

    if (baseName === undefined) {
        return false
    }

    const baseEntry = resolveCrossFileConstructionBase(baseName, crossFile, baseImportMap)

    return baseEntry?.isBaseDescendant === true &&
        baseEntry.fileName.endsWith(".d.ts") &&
        baseEntry.configRequiresArgument === true
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
