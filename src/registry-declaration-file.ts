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
    // (No default-export detection: a default-exported construction value is banned at
    // its own build — TS990016, the epic's decision 2 reversed §13.9.)

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
            configProperties       : configPropertiesFromConfigMeta(tsInstance, sourceFile, statement.name.text) ?? [],
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

// The `<Name>ConfigMeta` literal reader — the pure-type composition's replacement for
// the Pick-grammar recovery: the meta's `keys` / `requiredKeys` unions ARE the published
// key inventory, computed (const-string / unique-symbol) keys included as `typeof
// <entity>` queries spelled in the declaring file's own scope. Coherence with the config
// holds by construction (both derive from the same merged fact list at emit time).
// Returns undefined when the `.d.ts` carries no meta (an older emit, or a
// non-construction class) — the alias route still carries the config TYPE for typing;
// only the fact inventory degrades.
function configPropertiesFromConfigMeta(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    className: string
): ConfigProperty[] | undefined {
    const metaName = `${className}ConfigMeta`
    const meta     = sourceFile.statements.find((statement): statement is ts.TypeAliasDeclaration =>
        tsInstance.isTypeAliasDeclaration(statement) &&
        statement.name.text === metaName &&
        hasModifier(tsInstance, statement, tsInstance.SyntaxKind.ExportKeyword))

    const metaType = meta?.type

    if (metaType === undefined || !tsInstance.isTypeLiteralNode(metaType)) {
        return undefined
    }

    const fieldType = (fieldName: string): ts.TypeNode | undefined => metaType.members.find(
        (member): member is ts.PropertySignature =>
            tsInstance.isPropertySignature(member) &&
            propertyNameText(tsInstance, member.name) === fieldName
    )?.type

    const keys = fieldType("keys")

    if (keys === undefined) {
        return undefined
    }

    const requiredNames = new Set(metaKeyEntries(tsInstance, fieldType("requiredKeys")).map((entry) => entry.name))

    return metaKeyEntries(tsInstance, keys).map((entry) => ({
        name            : entry.name,
        optional        : !requiredNames.has(entry.name),
        computedKeyName : entry.computedKeyName
    }))
}

// One meta key union decomposed: string/numeric literal types name respellable keys;
// `typeof <entity>` queries name computed keys by their declaring-scope entity (the
// downstream transform treats them as unspellable identity — `transplantableConfigProperties`
// keeps them out of re-spelled renderings, while the alias route carries them natively).
function metaKeyEntries(
    tsInstance: TypeScript,
    typeNode: ts.TypeNode | undefined
): Array<{ name: string, computedKeyName?: string }> {
    if (typeNode === undefined || typeNode.kind === tsInstance.SyntaxKind.NeverKeyword) {
        return []
    }

    if (tsInstance.isUnionTypeNode(typeNode)) {
        return typeNode.types.flatMap((type) => metaKeyEntries(tsInstance, type))
    }

    if (tsInstance.isLiteralTypeNode(typeNode) &&
        (tsInstance.isStringLiteral(typeNode.literal) || tsInstance.isNumericLiteral(typeNode.literal))
    ) {
        return [ { name: typeNode.literal.text } ]
    }

    if (tsInstance.isTypeQueryNode(typeNode)) {
        const dotted = entityNameDottedText(tsInstance, typeNode.exprName)

        return dotted === undefined ? [] : [ { name: dotted, computedKeyName: dotted } ]
    }

    return []
}

function entityNameDottedText(tsInstance: TypeScript, entityName: ts.EntityName): string | undefined {
    if (tsInstance.isIdentifier(entityName)) {
        return entityName.text
    }

    const left = entityNameDottedText(tsInstance, entityName.left)

    return left === undefined ? undefined : `${left}.${entityName.right.text}`
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
            // A construction mixin's published key inventory comes from its `<Name>ConfigMeta`
            // literal (names, optionality, computed keys — `configPropertiesFromConfigMeta`).
            // The interface is the fallback only (a non-construction mixin, or an older emit
            // without the meta): it erases both the explicit-`public` convention and
            // initializer-implied optionality (every bare property signature reads required).
            const newParamConfig = requiredBaseIsPackageBase
                ? configPropertiesFromConfigMeta(tsInstance, sourceFile, declaration.name.text)
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
