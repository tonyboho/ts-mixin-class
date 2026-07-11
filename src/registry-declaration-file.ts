import type * as ts from "typescript"

import {
    isPackageBaseExpression
} from "./construction-chain.js"
import {
    uniqueConfigProperties,
    type ConfigProperty,
    type TransformOptions
} from "./model.js"
import { runtimeMixinClassLocalName } from "./naming.js"
import { propertyNameText } from "./util.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import type { Candidate } from "./registry.js"
import { hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

// Reading PUBLISHED declarations (`.d.ts`): reconstructing mixin candidates from their
// emitted `RuntimeMixinClass<...>` value types + interface chains, construction bases from
// their `static new` config parameter, and resolving whether a declaration has a JS runtime
// module next to it. The live-source builders stay in `registry.ts`; this module owns the
// declaration-file plane.

// Construction classes in an emitted `.d.ts`: a class declaration with a generated
// `static new(props: <config>): Self`. The config (already aggregated at emit time) is
// read straight off the parameter type (`Pick<Self, "a" | "b"> & Partial<Pick<Self,
// "c">>`), so downstream subclassing needs no further resolution.
export function collectDeclarationFileConstructionBases(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Array<{ name: string, configProperties: ConfigProperty[] }> {
    const bases: Array<{ name: string, configProperties: ConfigProperty[] }> = []
    // The generated `static new(props: <Name>Config)` references an exported config
    // alias declared alongside it in the same `.d.ts`; map alias name -> body so the
    // reader can resolve the reference back to its `Pick<...> & Partial<...>` shape.
    const configAliases = collectDeclarationFileTypeAliases(tsInstance, sourceFile)

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isClassDeclaration(statement) || statement.name === undefined) {
            continue
        }

        const staticNew = statement.members.find((member): member is ts.MethodDeclaration =>
            tsInstance.isMethodDeclaration(member) &&
            member.name !== undefined &&
            propertyNameText(tsInstance, member.name) === "new" &&
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword))

        const configType = staticNew?.parameters[0]?.type

        if (configType === undefined) {
            continue
        }

        bases.push({
            name             : statement.name.text,
            configProperties : configPropertiesFromConstructionNewParam(tsInstance, configType, false, configAliases, new Set())
        })
    }

    return bases
}

function collectDeclarationFileTypeAliases(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile
): Map<string, ts.TypeNode> {
    const aliases = new Map<string, ts.TypeNode>()

    for (const statement of sourceFile.statements) {
        if (tsInstance.isTypeAliasDeclaration(statement)) {
            aliases.set(statement.name.text, statement.type)
        }
    }

    return aliases
}

// Names (with optionality) carried by a generated construction config type:
// `Pick<Self, "a" | "b">` (required), `Partial<Pick<Self, "c">>` (optional),
// intersections of those, and a reference to a `<Name>Config` alias declared in the
// same `.d.ts` (resolved through `configAliases`). Type arguments on a generic alias
// are irrelevant - the config field names are string literals inside its `Pick`.
// Anything else contributes nothing.
function configPropertiesFromConstructionNewParam(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    optional: boolean,
    configAliases: Map<string, ts.TypeNode>,
    seenAliases: Set<string>
): ConfigProperty[] {
    if (tsInstance.isIntersectionTypeNode(typeNode)) {
        return uniqueConfigProperties(typeNode.types.flatMap((type) =>
            configPropertiesFromConstructionNewParam(tsInstance, type, optional, configAliases, seenAliases)))
    }

    if (tsInstance.isParenthesizedTypeNode(typeNode)) {
        return configPropertiesFromConstructionNewParam(tsInstance, typeNode.type, optional, configAliases, seenAliases)
    }

    if (!tsInstance.isTypeReferenceNode(typeNode) || !tsInstance.isIdentifier(typeNode.typeName)) {
        return []
    }

    if (typeNode.typeName.text === "Partial" && typeNode.typeArguments?.[0] !== undefined) {
        return configPropertiesFromConstructionNewParam(tsInstance, typeNode.typeArguments[0], true, configAliases, seenAliases)
    }

    if (typeNode.typeName.text === "Pick" && typeNode.typeArguments?.[1] !== undefined) {
        return literalStringNames(tsInstance, typeNode.typeArguments[1]).map((name) => ({ name, optional }))
    }

    const aliasBody = configAliases.get(typeNode.typeName.text)

    if (aliasBody !== undefined && !seenAliases.has(typeNode.typeName.text)) {
        seenAliases.add(typeNode.typeName.text)

        return configPropertiesFromConstructionNewParam(tsInstance, aliasBody, optional, configAliases, seenAliases)
    }

    return []
}

function literalStringNames(tsInstance: TypeScript, typeNode: ts.TypeNode): string[] {
    if (tsInstance.isLiteralTypeNode(typeNode) && tsInstance.isStringLiteral(typeNode.literal)) {
        return [ typeNode.literal.text ]
    }

    if (tsInstance.isUnionTypeNode(typeNode)) {
        return typeNode.types.flatMap((type) => literalStringNames(tsInstance, type))
    }

    return []
}

export function collectDeclarationFileMixinCandidates(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): Candidate[] {
    if (!sourceFile.text.includes(runtimeMixinClassLocalName)) {
        return []
    }

    const facts                   = getSourceFileFacts(tsInstance, sourceFile, options)
    const candidates: Candidate[] = []
    const interfaces              = new Map<string, ts.InterfaceDeclaration>()
    const defaultExportNames      = new Set<string>()

    for (const statement of sourceFile.statements) {
        if (tsInstance.isInterfaceDeclaration(statement)) {
            interfaces.set(statement.name.text, statement)
            continue
        }

        if (tsInstance.isExportAssignment(statement) && tsInstance.isIdentifier(statement.expression)) {
            defaultExportNames.add(statement.expression.text)
        }
    }

    for (const statement of sourceFile.statements) {
        if (!tsInstance.isVariableStatement(statement)) {
            continue
        }

        const exportedStatement = hasModifier(tsInstance, statement, tsInstance.SyntaxKind.ExportKeyword)

        for (const declaration of statement.declarationList.declarations) {
            if (!tsInstance.isIdentifier(declaration.name) ||
                declaration.type === undefined ||
                !typeReferencesRuntimeMixinClass(tsInstance, declaration.type)
            ) {
                continue
            }

            const defaultExport = defaultExportNames.has(declaration.name.text)

            if (!exportedStatement && !defaultExport) {
                continue
            }

            // The mixin's `RuntimeMixinClass<Base>` marker carries its required base. When
            // that base is the package `Base`, the mixin is construction-enabled, so a
            // consumer of it (from this declaration file) gets a generated `.new`. The flag
            // is otherwise lost for `.d.ts`, leaving downstream construction undetected. The
            // package base also appears in the merged `interface … extends Base, …`, so drop
            // it from the dependency (mixin) names — it is the base, not a consumed mixin.
            const requiredBaseIdentifier    = runtimeMixinClassRequiredBaseIdentifier(tsInstance, declaration.type)
            const requiredBaseIsPackageBase = requiredBaseIdentifier !== undefined &&
                isPackageBaseExpression(tsInstance, requiredBaseIdentifier, options, facts)
            const extendsNames              = interfaceExtendsNames(tsInstance, interfaces.get(declaration.name.text))

            candidates.push({
                sourceFile,
                name            : declaration.name.text,
                dependencyNames : requiredBaseIsPackageBase
                    ? extendsNames.filter((name) => name !== requiredBaseIdentifier.text)
                    : extendsNames,
                requiredBaseName    : requiredBaseIsPackageBase ? requiredBaseIdentifier.text : undefined,
                requiredBaseIsPackageBase,
                configProperties    : interfaceConfigProperties(tsInstance, interfaces.get(declaration.name.text)),
                declarationHeritage : true,
                defaultExport
            })
        }
    }

    return candidates
}

// Locates the `RuntimeMixinClass<…>` marker type reference inside a mixin value's
// declared type, descending through intersections/unions (`… & RuntimeMixinClass<Base>`)
// and parentheses. Returns the reference node itself (so callers can read its type
// argument), or undefined when the type carries no such marker.
function findRuntimeMixinClassReference(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode
): ts.TypeReferenceNode | undefined {
    if (tsInstance.isTypeReferenceNode(typeNode) &&
        tsInstance.isIdentifier(typeNode.typeName) &&
        typeNode.typeName.text === runtimeMixinClassLocalName
    ) {
        return typeNode
    }

    if (tsInstance.isIntersectionTypeNode(typeNode) || tsInstance.isUnionTypeNode(typeNode)) {
        for (const type of typeNode.types) {
            const found = findRuntimeMixinClassReference(tsInstance, type)

            if (found !== undefined) {
                return found
            }
        }

        return undefined
    }

    if (tsInstance.isParenthesizedTypeNode(typeNode)) {
        return findRuntimeMixinClassReference(tsInstance, typeNode.type)
    }

    return undefined
}

// The required-base identifier from a `RuntimeMixinClass<Base>` marker inside the
// mixin value's declared type. `RuntimeMixinClass` with no type argument (a mixin
// without a required base) yields undefined.
function runtimeMixinClassRequiredBaseIdentifier(tsInstance: TypeScript, typeNode: ts.TypeNode): ts.Identifier | undefined {
    const argument = runtimeMixinClassRequiredBaseTypeNode(tsInstance, typeNode)

    return argument !== undefined &&
        tsInstance.isTypeReferenceNode(argument) &&
        tsInstance.isIdentifier(argument.typeName)
        ? argument.typeName
        : undefined
}

export function runtimeMixinClassRequiredBaseTypeNode(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode
): ts.TypeNode | undefined {
    return findRuntimeMixinClassReference(tsInstance, typeNode)?.typeArguments?.[0]
}

function typeReferencesRuntimeMixinClass(tsInstance: TypeScript, typeNode: ts.TypeNode): boolean {
    return findRuntimeMixinClassReference(tsInstance, typeNode) !== undefined
}

function interfaceExtendsNames(
    tsInstance: TypeScript,
    declaration: ts.InterfaceDeclaration | undefined
): string[] {
    const clause = declaration?.heritageClauses?.find((heritageClause) => {
        return heritageClause.token === tsInstance.SyntaxKind.ExtendsKeyword
    })

    if (clause === undefined) {
        return []
    }

    return clause.types
        .map((heritageType) => heritageType.expression)
        .filter((expression): expression is ts.Identifier => tsInstance.isIdentifier(expression))
        .map((expression) => expression.text)
}

function interfaceConfigProperties(
    tsInstance: TypeScript,
    declaration: ts.InterfaceDeclaration | undefined
): ConfigProperty[] {
    if (declaration === undefined) {
        return []
    }

    return uniqueConfigProperties(
        declaration.members
            .filter((member): member is ts.PropertySignature => {
                return tsInstance.isPropertySignature(member) && member.name !== undefined
            })
            .flatMap((member) => {
                const name = propertyNameText(tsInstance, member.name)

                return name === undefined
                    ? []
                    : [ {
                        name,
                        optional : member.questionToken !== undefined
                    } ]
            })
    )
}

export function hasRuntimeModuleForDeclaration(
    tsInstance: TypeScript,
    compilerHost: ts.CompilerHost,
    fileName: string
): boolean {
    if (!fileName.endsWith(".d.ts") && !fileName.endsWith(".d.mts") && !fileName.endsWith(".d.cts")) {
        return true
    }

    return runtimeModuleFileNames(fileName).some((runtimeFileName) => {
        return compilerHost.fileExists(runtimeFileName) ||
            tsInstance.sys.fileExists(runtimeFileName)
    })
}

function runtimeModuleFileNames(declarationFileName: string): string[] {
    if (declarationFileName.endsWith(".d.mts")) {
        return [
            declarationFileName.slice(0, -".d.mts".length) + ".mjs",
            declarationFileName.slice(0, -".d.mts".length) + ".js"
        ]
    }

    if (declarationFileName.endsWith(".d.cts")) {
        return [
            declarationFileName.slice(0, -".d.cts".length) + ".cjs",
            declarationFileName.slice(0, -".d.cts".length) + ".js"
        ]
    }

    return [
        declarationFileName.slice(0, -".d.ts".length) + ".js",
        declarationFileName.slice(0, -".d.ts".length) + ".mjs",
        declarationFileName.slice(0, -".d.ts".length) + ".cjs"
    ]
}
