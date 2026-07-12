import type * as ts from "typescript"

import {
    isPackageBaseExpression
} from "./construction-chain.js"
import { collectTypeReferenceNames } from "./expand-util.js"
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
): Array<{ name: string, configProperties: ConfigProperty[], configRequiresArgument: boolean, configAliasAvailable: boolean }> {
    const bases: Array<{
        name                   : string,
        configProperties       : ConfigProperty[],
        configRequiresArgument : boolean,
        configAliasAvailable   : boolean
    }> = []
    // The generated `static new(props: <Name>Config)` references an exported config
    // alias declared alongside it in the same `.d.ts`; map alias name -> body so the
    // reader can resolve the reference back to its `Pick<...> & Partial<...>` shape.
    // (No default-export detection: a default-exported construction value is banned at
    // its own build — TS990016, the epic's decision 2 reversed §13.9.)
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

        if (configType === undefined || staticNew === undefined) {
            continue
        }

        bases.push({
            name                   : statement.name.text,
            configProperties       : configPropertiesFromConstructionNewParam(tsInstance, configType, false, configAliases, new Set()),
            configRequiresArgument : staticNew.parameters[0].questionToken === undefined,
            configAliasAvailable   : declarationFileExportsConfigAlias(tsInstance, sourceFile, statement.name.text)
        })
    }

    return bases
}

// Whether the `.d.ts` EXPORTS the `<Name>Config` alias — the whole alias-route
// availability test for a published contributor: the emitted alias exists exactly when
// the transformer generated it (construction-enabled, no user `static new`, no reserved
// collision), and its export tracks the class's (§7.15), so presence-of-exported-alias
// is precise with no re-derivation.
function declarationFileExportsConfigAlias(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    className: string
): boolean {
    const aliasName = `${className}Config`

    return sourceFile.statements.some((statement) =>
        tsInstance.isTypeAliasDeclaration(statement) &&
        statement.name.text === aliasName &&
        hasModifier(tsInstance, statement, tsInstance.SyntaxKind.ExportKeyword))
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

    // A published config's EXPLICIT members (`{ scale?: number | string }` — the emit spells
    // settable-accessor keys out so the SETTER type survives, see construction-config).
    // Generated explicit members are always optional; the value type is carried only when
    // self-contained (no named type references), since the node transplants verbatim into
    // the consuming file — a referencing type degrades to the name-only `Pick` typing.
    if (tsInstance.isTypeLiteralNode(typeNode)) {
        return uniqueConfigProperties(typeNode.members.flatMap((member) => {
            if (!tsInstance.isPropertySignature(member)) {
                return []
            }

            const name = propertyNameText(tsInstance, member.name)

            if (name === undefined) {
                return []
            }

            const memberOptional = optional || member.questionToken !== undefined
            const references     = member.type === undefined
                ? undefined
                : collectTypeReferenceNames(tsInstance, member.type)

            return [ {
                name,
                optional  : memberOptional,
                valueType : memberOptional && references !== undefined && references.size === 0
                    ? member.type
                    : undefined
            } ]
        }))
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

// String AND numeric literal keys: a published `Pick<Exotic, 0 | "dash-name">` spells a
// numeric field's key as a NUMERIC literal type (see `configKeyType`), which names the same
// property as its string text — recovered as "0" and re-emitted numeric downstream. `typeof
// const`/`typeof symbol` keys are deliberately NOT recovered here: a computed key cannot be
// spelled outside its declaring file (same rule as `transplantableConfigProperties`).
function literalStringNames(tsInstance: TypeScript, typeNode: ts.TypeNode): string[] {
    if (tsInstance.isLiteralTypeNode(typeNode) &&
        (tsInstance.isStringLiteral(typeNode.literal) || tsInstance.isNumericLiteral(typeNode.literal))
    ) {
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
    const configAliases           = collectDeclarationFileTypeAliases(tsInstance, sourceFile)

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
            // A construction mixin's published value carries its EXACT config through the
            // generated `"new"(props?: <Name>Config)` member — names, optionality AND the
            // spelled-out setter types. The interface is the fallback only: it erases both
            // the explicit-`public` convention and initializer-implied optionality (every
            // bare property signature would read as a required key).
            const newParamConfig = requiredBaseIsPackageBase
                ? mixinValueNewConfigProperties(tsInstance, declaration.type, configAliases)
                : undefined

            candidates.push({
                sourceFile,
                name            : declaration.name.text,
                dependencyNames : requiredBaseIsPackageBase
                    ? extendsNames.filter((name) => name !== requiredBaseIdentifier.text)
                    : extendsNames,
                requiredBaseName : requiredBaseIsPackageBase ? requiredBaseIdentifier.text : undefined,
                requiredBaseIsPackageBase,
                configProperties : newParamConfig ??
                    interfaceConfigProperties(tsInstance, interfaces.get(declaration.name.text)),
                configRequiresArgument : requiredBaseIsPackageBase
                    ? mixinValueNewRequiresArgument(tsInstance, declaration.type)
                    : undefined,
                declarationHeritage  : true,
                defaultExport,
                configAliasAvailable : declarationFileExportsConfigAlias(tsInstance, sourceFile, declaration.name.text),
                generic              : (interfaces.get(declaration.name.text)?.typeParameters?.length ?? 0) > 0
            })
        }
    }

    return candidates
}

// The exact config of a published construction mixin, read off the generated
// `"new"(props?: <Name>Config)` member of its declared value type — undefined when no
// such member exists (a non-construction mixin, or an older emit shape).
function mixinValueNewConfigProperties(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode,
    configAliases: Map<string, ts.TypeNode>
): ConfigProperty[] | undefined {
    const configType = mixinValueNewConfigType(tsInstance, typeNode)

    return configType === undefined
        ? undefined
        : configPropertiesFromConstructionNewParam(tsInstance, configType, false, configAliases, new Set())
}

// TRUE when the published `"new"(props: …)` parameter is required — the flag that keeps a
// downstream `.new` argument required even though the respelled fact transport loses the
// computed/symbol keys carrying the requirement (§13.8). Undefined-shaped values (no `"new"`
// member) yield false.
function mixinValueNewRequiresArgument(tsInstance: TypeScript, typeNode: ts.TypeNode): boolean {
    const newMember = mixinValueNewMember(tsInstance, typeNode)

    return newMember !== undefined &&
        newMember.parameters[0] !== undefined &&
        newMember.parameters[0].questionToken === undefined
}

function mixinValueNewConfigType(tsInstance: TypeScript, typeNode: ts.TypeNode): ts.TypeNode | undefined {
    return mixinValueNewMember(tsInstance, typeNode)?.parameters[0]?.type
}

function mixinValueNewMember(tsInstance: TypeScript, typeNode: ts.TypeNode): ts.MethodSignature | undefined {
    if (tsInstance.isIntersectionTypeNode(typeNode)) {
        for (const type of typeNode.types) {
            const found = mixinValueNewMember(tsInstance, type)

            if (found !== undefined) {
                return found
            }
        }

        return undefined
    }

    if (tsInstance.isParenthesizedTypeNode(typeNode)) {
        return mixinValueNewMember(tsInstance, typeNode.type)
    }

    if (!tsInstance.isTypeLiteralNode(typeNode)) {
        return undefined
    }

    return typeNode.members.find((member): member is ts.MethodSignature =>
        tsInstance.isMethodSignature(member) &&
        propertyNameText(tsInstance, member.name) === "new")
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

export function typeReferencesRuntimeMixinClass(tsInstance: TypeScript, typeNode: ts.TypeNode): boolean {
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
        declaration.members.flatMap((member) => {
            if (tsInstance.isPropertySignature(member)) {
                const name = propertyNameText(tsInstance, member.name)

                return name === undefined
                    ? []
                    : [ {
                        name,
                        optional : member.questionToken !== undefined
                    } ]
            }

            // A published SET accessor is assignable through `.new`'s Object.assign, so it is
            // a config key exactly like a program-local one. Its setter type node is carried
            // only when SELF-CONTAINED (keywords/literals — no named type references): the
            // node transplants into the consumer's file verbatim, and a name from the
            // declaration file would dangle there. A referencing setter type falls back to
            // the `Pick` path (getter-typed) — the documented narrower limitation.
            if (tsInstance.isSetAccessorDeclaration(member)) {
                const name = propertyNameText(tsInstance, member.name)

                if (name === undefined) {
                    return []
                }

                const parameterType = member.parameters[0]?.type
                const references    = parameterType === undefined
                    ? undefined
                    : collectTypeReferenceNames(tsInstance, parameterType)

                return [ {
                    name,
                    optional  : true,
                    valueType : references !== undefined && references.size === 0 ? parameterType : undefined
                } ]
            }

            return []
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
