import type * as ts from "typescript"
import { MixinTransformError } from "./expand-util.js"
import {
    accumulateRegisteredMixinConfig,
    registryKey,
    uniqueConfigProperties,
    type ConfigProperty,
    type ConstructionBaseEntry,
    type CrossFileContext,
    type ImportedNameBinding,
    type ResolvedMixinRef,
    type TransformOptions
} from "./model.js"
import { getSourceFileFacts, type SourceFileFacts } from "./source-file-facts.js"
import {
    collapseSubtreeTextRange,
    deepCloneNode,
    hasModifier,
    preserveGeneratedDeclarationRange,
    preserveTextRange
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
    baseImportMap?: Map<string, ImportedNameBinding>,
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
    // class's own type parameters) rather than inlining the `Pick<...>` at the `new`
    // param: `.new(...)` type errors then read the clean alias name, and the alias is
    // reusable as a factory-parameter / annotation type. (It is NOT a valid `initialize`
    // override type - the base `initialize` is all-optional; see the README note.)
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
// caller lists AFTER the class. BOTH modes collapse the whole subtree to one real anchor
// at `declaration.end` - the gap just past the closing brace, OUTSIDE the class body,
// where the alias overlaps no sibling and no navigable user token:
//   - it is a real, in-tree position, so `alignGeneratedNavigableNodesWithParseTree`
//     clears the alias's `Synthesized` flag and `getParseTreeNode` resolves it to itself
//     rather than walking `.original` into the unbound source-view clone and crashing
//     when a user reference to the alias renders its display (find-references / quickinfo);
//   - collapsing maps a perturbed config key that errors inside the alias body (e.g.
//     TS2344) to the anchor column in both modes, so emit and source view stay parity-
//     aligned (the same trick the construction `static new` members use); and
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
    baseImportMap?: Map<string, ImportedNameBinding>
): MixinConstructionNew | undefined {
    if (declaration.name === undefined ||
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
    return {
        newType : factory.createTypeLiteralNode([
            factory.createMethodSignature(
                undefined,
                factory.createStringLiteral("new"),
                undefined,
                undefined,
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
    baseImportMap?: Map<string, ImportedNameBinding>
): boolean {
    if (baseType === undefined) {
        return false
    }

    if (isPackageBaseExpression(tsInstance, baseType.expression, options, facts)) {
        return true
    }

    if (!tsInstance.isIdentifier(baseType.expression)) {
        return false
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
export function resolveCrossFileConstructionBase(
    name: string,
    crossFile: CrossFileContext | undefined,
    baseImportMap: Map<string, ImportedNameBinding> | undefined
): ConstructionBaseEntry | undefined {
    if (crossFile === undefined || baseImportMap === undefined) {
        return undefined
    }

    const imported = baseImportMap.get(name)

    return imported === undefined
        ? undefined
        : crossFile.constructionBases.get(registryKey(imported.resolvedFileName, imported.importedName))
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
    baseImportMap?: Map<string, ImportedNameBinding>
): ConstructionConfig {
    const factory = tsInstance.factory

    const properties              = staticConstructionConfigProperties(
        tsInstance,
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
        type              : parts.length === 1 ? parts[0] : factory.createIntersectionTypeNode(parts),
        optionalParameter : requiredType === undefined
    }
}

function staticConstructionConfigProperties(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    extendsType: ts.ExpressionWithTypeArguments | undefined,
    implicitRequiredBase: ts.ExpressionWithTypeArguments | undefined,
    mixinRefs: ResolvedMixinRef[],
    facts: SourceFileFacts,
    crossFile?: CrossFileContext,
    baseImportMap?: Map<string, ImportedNameBinding>
): ConfigProperty[] {
    return uniqueConfigProperties([
        ...baseConfigProperties(tsInstance, extendsType ?? implicitRequiredBase, facts, crossFile, baseImportMap, new Set()),
        ...mixinRefs.flatMap((ref) => ref.configProperties),
        ...(facts.classesByDeclaration.get(declaration)?.configProperties ?? [])
    ])
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

// Accumulates the full construction config a base contributes to a subclass's
// `.new(...)`: the base's own public fields, those inherited up its own `extends`
// chain, and those of every mixin it consumes - recursively. A local base may itself
// be a construction consumer (it extends another construction base and/or implements
// mixins), so reading only its own fields drops inherited config and breaks the
// static-side `new` along the chain (TS2417). Imported bases are read from the
// cross-file registry, which carries the accumulated extends-chain config.
function baseConfigProperties(
    tsInstance: TypeScript,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: Map<string, ImportedNameBinding> | undefined,
    seen: Set<string>
): ConfigProperty[] {
    if (baseType === undefined || !tsInstance.isIdentifier(baseType.expression)) {
        return []
    }

    return configPropertiesForName(tsInstance, baseType.expression.text, facts, crossFile, baseImportMap, seen)
}

function configPropertiesForName(
    tsInstance: TypeScript,
    name: string,
    facts: SourceFileFacts,
    crossFile: CrossFileContext | undefined,
    baseImportMap: Map<string, ImportedNameBinding> | undefined,
    seen: Set<string>
): ConfigProperty[] {
    if (seen.has(name)) {
        return []
    }

    seen.add(name)

    const localClass = facts.classesByName.get(name)

    if (localClass !== undefined) {
        return uniqueConfigProperties([
            ...baseConfigProperties(tsInstance, localClass.extendsType, facts, crossFile, baseImportMap, seen),
            ...localClass.implementsIdentifierNames.flatMap((implemented) =>
                configPropertiesForName(tsInstance, implemented, facts, crossFile, baseImportMap, seen)),
            ...localClass.configProperties
        ])
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
    baseImportMap: Map<string, ImportedNameBinding> | undefined,
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
export function constructionConfigAliasName(
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
