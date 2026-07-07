import type * as ts from "typescript"
import { dottedExpressionText, intersectionOrSingle, MixinTransformError, rewriteTypeReferences } from "./expand-util.js"
import {
    type ImportMap,
    importedBindingRegistryKey,
    accumulateRegisteredMixinConfig,
    registryKey,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionBaseEntry,
    type CrossFileContext,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { getSourceFileFacts, qualifiedLocalClassFacts, type ClassFacts, type SourceFileFacts } from "./source-file-facts.js"
import {
    collapseSubtreeTextRange,
    deepCloneNode,
    hasModifier,
    preserveGeneratedDeclarationRange,
    preserveTextRange,
    stripVarianceAnnotations
} from "./util.js"
import type { TypeScript } from "./util.js"

type ConstructionConfig = {
    type              : ts.TypeNode,
    optionalParameter : boolean
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
    configAlias : ts.TypeAliasDeclaration | undefined
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
    requiredBaseIsConstructionBase = false
): ConstructionMembers {
    const facts = getSourceFileFacts(tsInstance, sourceFile, options)

    if (declaration.name === undefined ||
        facts.classesByDeclaration.get(declaration)?.hasStaticNew === true ||
        !(
            requiredBaseIsConstructionBase ||
            isConstructionBaseOptIn(
                tsInstance, sourceFile, extendsType ?? implicitRequiredBase, options, facts, new Set(), crossFile, baseImportMap
            )
        )
    ) {
        return { members: [], configAlias: undefined }
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
    // class's own type parameters). In EMIT the `new` param references it, so `.new(...)`
    // type errors read the clean alias name; in SOURCE VIEW the param inlines the structural
    // config (the synthetic alias name cannot render — see `constructionConfigParamType`).
    // Either way the alias is reusable as a factory-parameter / annotation type. (It is NOT a
    // valid `initialize` override type - the base `initialize` is all-optional; see the README.)
    const aliasName       = constructionConfigAliasName(tsInstance, sourceFile, declaration)
    const configAlias     = createConstructionConfigAlias(tsInstance, declaration, aliasName, config.type)
    const configReference = createConfigAliasReference(tsInstance, declaration, aliasName)

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
        finishMember(factory.createMethodDeclaration(
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
        ), 0),
        // The implementation overload (never visible to callers; the typed overload above is
        // what they resolve to). Its parameter MUST stay `any`, not `unknown`: the body
        // forwards `props` to `super.new(props)`, and in a construction *subclass* `super.new`
        // resolves to the PARENT's typed overload `new(props: ParentConfig)` — only `any` is
        // assignable to an arbitrary parent config (contravariantly); `unknown` is rejected
        // (TS2345). The return type is `unknown` (better than `any`): callers never see it,
        // and the body's `super.new(props)` (typed `Base`) is assignable to `unknown`.
        finishMember(factory.createMethodDeclaration(
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
            factory.createBlock([
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
            ], true)
        ), 1)
    ]

    return { members, configAlias }
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
    configAlias : ts.TypeAliasDeclaration
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
    baseImportMap?: ImportMap
): MixinConstructionNew | undefined {
    if (declaration.name === undefined ||
        facts.classesByDeclaration.get(declaration)?.hasStaticNew === true ||
        !isConstructionBaseOptIn(tsInstance, sourceFile, extendsType, options, facts, new Set(), crossFile, baseImportMap)
    ) {
        return undefined
    }

    const factory = tsInstance.factory
    const config  = createConstructionConfig(
        tsInstance, sourceFile, declaration, extendsType, undefined, mixinRefs, options, facts, crossFile, baseImportMap
    )
    // A construction-base mixin is just a class for config purposes, so it gets the
    // same exported `<MixinName>Config` alias - emitted in both the value-cast (emit)
    // and the `static new` (source view) forms so the symbol exists in both.
    const aliasName = constructionConfigAliasName(tsInstance, sourceFile, declaration)

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
                    createConfigAliasReference(tsInstance, declaration, aliasName)
                ) ],
                createConsumerInstanceType(tsInstance, declaration)
            )
        ]),
        configAlias : createConstructionConfigAlias(tsInstance, declaration, aliasName, config.type)
    }
}

export function isConstructionBaseOptIn(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    options: TransformOptions,
    facts = getSourceFileFacts(tsInstance, sourceFile, options),
    seen = new Set<string>(),
    crossFile?: CrossFileContext,
    baseImportMap?: ImportMap
): boolean {
    if (baseType === undefined) {
        return false
    }

    if (isPackageBaseExpression(tsInstance, baseType.expression, options, facts)) {
        return true
    }

    // A QUALIFIED base (`data.Model`) resolves through the local-namespace index; the
    // dotted text keys the `seen` set (disjoint from plain identifiers, which never
    // contain a dot). When the dotted name is not a local namespace path, it may be a
    // NAMESPACE-IMPORT member (`lib.Model`), resolved through the cross-file registry.
    // (`isPackageBaseExpression` above already accepted the package `ns.Base` form.)
    if (!tsInstance.isIdentifier(baseType.expression)) {
        const dottedName = dottedExpressionText(tsInstance, baseType.expression)

        if (dottedName === undefined || seen.has(dottedName)) {
            return false
        }

        seen.add(dottedName)

        const qualifiedBase = qualifiedLocalClassFacts(tsInstance, sourceFile, baseType.expression, facts)

        if (qualifiedBase === undefined) {
            return resolveCrossFileConstructionBase(dottedName, crossFile, baseImportMap)?.isBaseDescendant === true
        }

        return isConstructionBaseOptIn(
            tsInstance, sourceFile, qualifiedBase.extendsType, options, facts, seen, crossFile, baseImportMap
        )
    }

    const baseName = baseType.expression.text

    if (seen.has(baseName)) {
        return false
    }

    seen.add(baseName)

    const localBase = facts.classesByName.get(baseName)

    if (localBase !== undefined) {
        return isConstructionBaseOptIn(
            tsInstance, sourceFile, localBase.extendsType, options, facts, seen, crossFile, baseImportMap
        )
    }

    // The base is not declared in this file: it may be an imported class that
    // transitively extends the package `Base`, recorded in the cross-file
    // construction-base registry.
    return resolveCrossFileConstructionBase(baseName, crossFile, baseImportMap)?.isBaseDescendant === true
}

// Resolves a local base identifier to its cross-file construction-base entry,
// when the name is imported and the imported class transitively extends `Base`.
// A DOTTED name (`lib.Model`) resolves through its namespace-import binding —
// exactly one dot: registry entries are top-level classes of their module, so a
// deeper path can never name one.
export function resolveCrossFileConstructionBase(
    name: string,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined
): ConstructionBaseEntry | undefined {
    if (crossFile === undefined || baseImportMap === undefined) {
        return undefined
    }

    const key = importedBindingRegistryKey(name, baseImportMap)

    return key === undefined ? undefined : crossFile.constructionBases.get(key)
}

export function isPackageBaseExpression(
    tsInstance: TypeScript,
    expression: ts.Expression,
    options: TransformOptions,
    facts: SourceFileFacts
): boolean {
    for (const importFacts of facts.imports) {
        if (!isPackageBaseImport(importFacts.specifier, options)) {
            continue
        }

        const importClause  = importFacts.declaration.importClause
        const namedBindings = importClause?.namedBindings

        if (namedBindings === undefined) {
            continue
        }

        if (tsInstance.isNamespaceImport(namedBindings) &&
            tsInstance.isPropertyAccessExpression(expression) &&
            tsInstance.isIdentifier(expression.expression) &&
            expression.expression.text === namedBindings.name.text &&
            expression.name.text === "Base"
        ) {
            return true
        }

        if (!tsInstance.isNamedImports(namedBindings) || !tsInstance.isIdentifier(expression)) {
            continue
        }

        if (namedBindings.elements.some((element) => {
            return (element.propertyName?.text ?? element.name.text) === "Base" &&
                element.name.text === expression.text
        })) {
            return true
        }
    }

    return false
}

function isPackageBaseImport(
    specifier: string,
    options: TransformOptions
): boolean {
    return specifier === options.packageName || specifier === `${options.packageName}/base`
}

// Construction-base opt-in can only ever resolve to true when the file itself
// imports the package `Base` (the `isConstructionBaseOptIn` chain terminates at
// `isPackageBaseExpression`, which requires a local package-base import). The
// transform gate uses this as a cheap pre-check so files that merely extend some
// ordinary class are not cloned and walked in source-view mode.
export function importsPackageBase(
    tsInstance: TypeScript,
    facts: SourceFileFacts,
    options: TransformOptions
): boolean {
    for (const importFacts of facts.imports) {
        if (!isPackageBaseImport(importFacts.specifier, options)) {
            continue
        }

        const namedBindings = importFacts.declaration.importClause?.namedBindings

        if (namedBindings === undefined) {
            continue
        }

        if (tsInstance.isNamespaceImport(namedBindings)) {
            return true
        }

        if (namedBindings.elements.some((element) => {
            return (element.propertyName?.text ?? element.name.text) === "Base"
        })) {
            return true
        }
    }

    return false
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

    const properties              = staticConstructionConfigProperties(
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
    const requiredNames: string[] = []
    const optionalNames: string[] = []
    // Settable accessors that carry a setter type are emitted as explicit members (typed by
    // the setter, not the getter a `Pick` would read); everything else goes through `Pick`.
    const explicitMembers: ts.PropertySignature[] = []

    for (const property of properties) {
        if (property.valueType !== undefined) {
            explicitMembers.push(factory.createPropertySignature(
                undefined,
                factory.createIdentifier(property.name),
                property.optional ? factory.createToken(tsInstance.SyntaxKind.QuestionToken) : undefined,
                deepCloneNode(tsInstance, property.valueType)
            ))
        } else if (property.optional) {
            optionalNames.push(property.name)
        } else {
            requiredNames.push(property.name)
        }
    }

    const consumerType = createConsumerInstanceType(tsInstance, declaration)
    const requiredType = requiredNames.length === 0
        ? undefined
        : factory.createTypeReferenceNode("Pick", [
            consumerType,
            literalKeyUnionType(tsInstance, requiredNames)
        ])
    const optionalType = optionalNames.length === 0
        ? undefined
        : factory.createTypeReferenceNode("Partial", [
            factory.createTypeReferenceNode("Pick", [
                consumerType,
                literalKeyUnionType(tsInstance, optionalNames)
            ])
        ])
    const explicitType = explicitMembers.length === 0
        ? undefined
        : factory.createTypeLiteralNode(explicitMembers)

    // Explicit accessor members are always optional, so they never force a required param.
    const parts = ([ requiredType, optionalType, explicitType ] as Array<ts.TypeNode | undefined>).filter(
        (part): part is ts.TypeNode => part !== undefined)

    if (parts.length === 0) {
        return {
            type : factory.createTypeReferenceNode("Partial", [
                factory.createTypeReferenceNode("Pick", [
                    consumerType,
                    factory.createKeywordTypeNode(tsInstance.SyntaxKind.NeverKeyword)
                ])
            ]),
            optionalParameter : true
        }
    }

    return {
        type              : flattenIfIntersection(tsInstance, parts),
        optionalParameter : requiredType === undefined
    }
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
            deepCloneNode(tsInstance, combined),
            factory.createTypeReferenceNode("K", undefined)
        ),
        undefined
    )
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
    return uniqueConfigProperties([
        ...baseConfigProperties(tsInstance, sourceFile, extendsType ?? implicitRequiredBase, facts, crossFile, baseImportMap, new Set()),
        ...mixinRefs.flatMap((ref) => substituteMixinConfigTypeParameters(tsInstance, declaration, ref)),
        ...(facts.classesByDeclaration.get(declaration)?.configProperties ?? [])
    ])
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
    const typeParameters = ref.declaration?.typeParameters

    if (typeParameters === undefined || typeParameters.length === 0 ||
        ref.configProperties.every((property) => property.valueType === undefined)) {
        return ref.configProperties
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

    return ref.configProperties.map((property) => property.valueType === undefined
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

function literalKeyUnionType(
    tsInstance: TypeScript,
    names: string[]
): ts.TypeNode {
    const factory = tsInstance.factory

    return names.length === 1
        ? factory.createLiteralTypeNode(factory.createStringLiteral(names[0]))
        : factory.createUnionTypeNode(names.map((name) => {
            return factory.createLiteralTypeNode(factory.createStringLiteral(name))
        }))
}

// How a QUALIFIED base's locally-resolvable extends chain leaves the file. The
// construction-base registry resolves a candidate's qualified base with this walk: the
// chain either reaches the package `Base` import (`isPackageBase`), or exits at a
// reference no local class declares — an imported identifier, or a namespace-import
// member when the qualified path itself is not local — whose name (`unresolvedName`)
// the registry chases through its ordinary imported-candidate resolution.
// `configProperties` carries what the LOCAL levels of the chain contribute (their own
// fields, local extends levels and local mixins); the imported tail's contribution is
// added by the caller's own resolution. Returns undefined when the chain dead-ends
// locally (no `extends`, a cycle, or an unresolvable dotted path).
export type QualifiedBaseChainExit = {
    isPackageBase    : boolean,
    unresolvedName   : string | undefined,
    configProperties : ConfigProperty[]
}

export function qualifiedConstructionChainExit(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments,
    options: TransformOptions,
    facts: SourceFileFacts
): QualifiedBaseChainExit | undefined {
    const dottedName = dottedExpressionText(tsInstance, baseType.expression)

    if (dottedName === undefined) {
        return undefined
    }

    const firstLocal = qualifiedLocalClassFacts(tsInstance, sourceFile, baseType.expression, facts)

    // Not a local namespace path — a namespace-import member; nothing local to fold in.
    if (firstLocal === undefined) {
        return { isPackageBase: false, unresolvedName: dottedName, configProperties: [] }
    }

    const seen  = new Set<string>([ dottedName ])
    let current = firstLocal
    let exit: { isPackageBase: boolean, unresolvedName: string | undefined }

    for (;;) {
        const currentBase = current.extendsType

        if (currentBase === undefined) {
            return undefined
        }

        if (isPackageBaseExpression(tsInstance, currentBase.expression, options, facts)) {
            exit = { isPackageBase: true, unresolvedName: undefined }
            break
        }

        const key = tsInstance.isIdentifier(currentBase.expression)
            ? currentBase.expression.text
            : dottedExpressionText(tsInstance, currentBase.expression)

        if (key === undefined || seen.has(key)) {
            return undefined
        }

        seen.add(key)

        const next = tsInstance.isIdentifier(currentBase.expression)
            ? facts.classesByName.get(key)
            : qualifiedLocalClassFacts(tsInstance, sourceFile, currentBase.expression, facts)

        if (next === undefined) {
            exit = { isPackageBase: false, unresolvedName: key }
            break
        }

        current = next
    }

    return {
        ...exit,
        configProperties : localClassConfigProperties(
            tsInstance, sourceFile, firstLocal, facts, undefined, undefined, new Set()
        )
    }
}

// Accumulates the full construction config a base contributes to a subclass's
// `.new(...)`: the base's own public fields, those inherited up its own `extends`
// chain, and those of every mixin it consumes - recursively. A local base may itself
// be a construction consumer (it extends another construction base and/or implements
// mixins), so reading only its own fields drops inherited config and breaks the
// static-side `new` along the chain (TS2417). Imported bases are read from the
// cross-file registry, which carries the accumulated extends-chain config.
function baseConfigProperties(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    if (baseType === undefined) {
        return []
    }

    // A QUALIFIED base contributes its accumulated config through the local-namespace
    // index, keyed in `seen` by its dotted text (same convention as the opt-in walk);
    // a NAMESPACE-IMPORT member (`lib.Model`) reads its accumulated config from the
    // cross-file registry entry instead.
    if (!tsInstance.isIdentifier(baseType.expression)) {
        const dottedName = dottedExpressionText(tsInstance, baseType.expression)

        if (dottedName === undefined || seen.has(dottedName)) {
            return []
        }

        seen.add(dottedName)

        const qualifiedBase = qualifiedLocalClassFacts(tsInstance, sourceFile, baseType.expression, facts)

        if (qualifiedBase === undefined) {
            return resolveCrossFileConstructionBase(dottedName, crossFile, baseImportMap)?.configProperties ?? []
        }

        return localClassConfigProperties(tsInstance, sourceFile, qualifiedBase, facts, crossFile, baseImportMap, seen)
    }

    return configPropertiesForName(tsInstance, sourceFile, baseType.expression.text, facts, crossFile, baseImportMap, seen)
}

function localClassConfigProperties(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    localClass: ClassFacts,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    return uniqueConfigProperties([
        ...baseConfigProperties(tsInstance, sourceFile, localClass.extendsType, facts, crossFile, baseImportMap, seen),
        ...localClass.implementsIdentifierNames.flatMap((implemented) =>
            configPropertiesForName(tsInstance, sourceFile, implemented, facts, crossFile, baseImportMap, seen)),
        ...localClass.configProperties
    ])
}

function configPropertiesForName(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    name: string,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    if (seen.has(name)) {
        return []
    }

    seen.add(name)

    const localClass = facts.classesByName.get(name)

    if (localClass !== undefined) {
        return localClassConfigProperties(tsInstance, sourceFile, localClass, facts, crossFile, baseImportMap, seen)
    }

    // Not declared in this file: an imported construction base (its accumulated
    // extends-chain config lives in the cross-file registry) or an imported mixin
    // (its own plus dependency config lives in the mixin registry).
    const baseEntry = resolveCrossFileConstructionBase(name, crossFile, baseImportMap)

    if (baseEntry !== undefined) {
        return baseEntry.configProperties
    }

    return importedMixinConfigProperties(name, crossFile, baseImportMap, seen)
}

function importedMixinConfigProperties(
    name: string,
    crossFile: CrossFileContext | undefined,
    baseImportMap: ImportMap | undefined,
    seen: Set<string>
): ConfigProperty[] {
    const imported = baseImportMap?.get(name)

    if (imported === undefined || crossFile === undefined) {
        return []
    }

    return accumulateRegisteredMixinConfig(
        registryKey(imported.resolvedFileName, imported.importedName),
        crossFile.registry,
        seen
    )
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

// The generated, exported config-alias name for a construction class: `<ClassName>Config`,
// suffixed with `_` until it no longer collides with a name already declared or imported
// at the top level of the file. Falling back to a suffix (rather than to an inline `Pick`)
// keeps a single code path: the build always exposes a named alias.
function constructionConfigAliasName(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ClassDeclaration
): string {
    const taken = collectTopLevelDeclaredNames(tsInstance, sourceFile)

    let name = `${declaration.name?.text ?? ""}Config`

    while (taken.has(name)) {
        name += "_"
    }

    return name
}

function collectTopLevelDeclaredNames(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Set<string> {
    const names = new Set<string>()

    for (const statement of sourceFile.statements) {
        if ((tsInstance.isClassDeclaration(statement) ||
            tsInstance.isInterfaceDeclaration(statement) ||
            tsInstance.isTypeAliasDeclaration(statement) ||
            tsInstance.isEnumDeclaration(statement) ||
            tsInstance.isFunctionDeclaration(statement)) &&
            statement.name !== undefined
        ) {
            names.add(statement.name.text)
        } else if (tsInstance.isVariableStatement(statement)) {
            for (const variable of statement.declarationList.declarations) {
                if (tsInstance.isIdentifier(variable.name)) {
                    names.add(variable.name.text)
                }
            }
        } else if (tsInstance.isImportDeclaration(statement)) {
            collectImportNames(tsInstance, statement.importClause, names)
        }
    }

    return names
}

function collectImportNames(
    tsInstance: TypeScript,
    importClause: ts.ImportClause | undefined,
    names: Set<string>
): void {
    if (importClause === undefined) {
        return
    }

    if (importClause.name !== undefined) {
        names.add(importClause.name.text)
    }

    const namedBindings = importClause.namedBindings

    if (namedBindings === undefined) {
        return
    }

    if (tsInstance.isNamespaceImport(namedBindings)) {
        names.add(namedBindings.name.text)
        return
    }

    for (const element of namedBindings.elements) {
        names.add(element.name.text)
    }
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
