import type * as ts from "typescript"
import { MixinTransformError } from "./expand-util.js"
import {
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
    preserveGeneratedDeclarationRange,
    preserveTextRange
} from "./util.js"
import type { TypeScript } from "./util.js"

type ConstructionConfig = {
    type              : ts.TypeNode,
    optionalParameter : boolean
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
): ts.ClassElement[] {
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
        return []
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
            return preserveTextRange(tsInstance, member, overloadRange(index))
        }

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

    return [
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
                config.type
            ) ],
            consumerType,
            undefined
        ), 0),
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
            factory.createKeywordTypeNode(tsInstance.SyntaxKind.AnyKeyword),
            factory.createBlock([
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
}

// Construction `new` for a mixin's value type. A mixin that extends the package
// `Base` is construction-enabled, but unlike a consumer it has no class body to
// attach a generated `static new` to, so its value type otherwise inherits
// `Base.new`, which returns `Base` rather than the mixin's own instance type.
// This builds a `{ new(props?): Instance }` member that the value cast prepends
// so the mixin's standalone `.new(...)` resolves to the mixin type. Returns
// undefined when the mixin is not a construction base.
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
): ts.TypeNode | undefined {
    if (declaration.name === undefined ||
        !isConstructionBaseOptIn(tsInstance, sourceFile, extendsType, options, facts, new Set(), crossFile, baseImportMap)
    ) {
        return undefined
    }

    const factory = tsInstance.factory
    const config  = createConstructionConfig(
        tsInstance, sourceFile, declaration, extendsType, undefined, mixinRefs, options, facts, crossFile, baseImportMap
    )

    // A property signature (`new: (props?) => Instance`), not a method signature:
    // inside a type literal `new(...)` parses as a construct signature, which
    // would not provide a callable `.new` member. Consumers that apply this mixin
    // exclude its `new` from the inherited statics (see createMixinStaticsType),
    // so the property's strict parameter checking does not clash with a consumer's
    // own generated `static new`.
    return factory.createTypeLiteralNode([
        factory.createPropertySignature(
            undefined,
            "new",
            undefined,
            factory.createFunctionTypeNode(
                undefined,
                [ factory.createParameterDeclaration(
                    undefined,
                    undefined,
                    "props",
                    config.optionalParameter ? factory.createToken(tsInstance.SyntaxKind.QuestionToken) : undefined,
                    config.type
                ) ],
                createConsumerInstanceType(tsInstance, declaration)
            )
        )
    ])
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

    for (const property of properties) {
        if (property.optional) {
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

    if (requiredType === undefined && optionalType === undefined) {
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

    if (requiredType === undefined) {
        return {
            type              : optionalType as ts.TypeNode,
            optionalParameter : true
        }
    }

    if (optionalType === undefined) {
        return {
            type              : requiredType,
            optionalParameter : false
        }
    }

    return {
        type : factory.createIntersectionTypeNode([
            requiredType,
            optionalType
        ]),
        optionalParameter : false
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
        ...baseConfigProperties(tsInstance, extendsType ?? implicitRequiredBase, facts, crossFile, baseImportMap),
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

function baseConfigProperties(
    tsInstance: TypeScript,
    baseType: ts.ExpressionWithTypeArguments | undefined,
    facts: SourceFileFacts,
    crossFile?: CrossFileContext,
    baseImportMap?: Map<string, ImportedNameBinding>
): ConfigProperty[] {
    if (baseType === undefined || !tsInstance.isIdentifier(baseType.expression)) {
        return []
    }

    const baseName  = baseType.expression.text
    const localBase = facts.classesByName.get(baseName)

    if (localBase !== undefined) {
        return localBase.configProperties
    }

    // Imported base: the cross-file registry carries the accumulated config fields
    // of the base and all of its ancestors up to `Base`.
    return resolveCrossFileConstructionBase(baseName, crossFile, baseImportMap)?.configProperties ?? []
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
