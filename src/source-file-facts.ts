import type * as ts from "typescript"
import { collectMixinDecoratorImports, hasMixinDecorator } from "./decorators.js"
import {
    extendsClause,
    implementsTypes,
    propertyNameText,
    requiredBaseIdentifierName,
    uniqueConfigProperties,
    type ConfigProperty,
    type MixinDecoratorImports,
    type TransformOptions
} from "./model.js"
import { hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

export type ImportFacts = {
    declaration : ts.ImportDeclaration,
    specifier   : string,
    localNames  : string[]
}

export type ClassFacts = {
    declaration               : ts.ClassDeclaration,
    name                      : string | undefined,
    defaultExport             : boolean,
    extendsType               : ts.ExpressionWithTypeArguments | undefined,
    implementsTypes           : ts.ExpressionWithTypeArguments[],
    implementsIdentifierNames : string[],
    requiredBaseName          : string | undefined,
    configProperties          : ConfigProperty[],
    staticNames               : Set<string>,
    hasStaticNew              : boolean,
    hasMixinDecorator         : boolean
}

export type SourceFileFacts = {
    mixinDecoratorImports : MixinDecoratorImports,
    imports               : ImportFacts[],
    classes               : ClassFacts[],
    classesByName         : Map<string, ClassFacts>,
    classesByDeclaration  : Map<ts.ClassDeclaration, ClassFacts>
}

const sourceFileFactsCache = new WeakMap<ts.SourceFile, Map<string, SourceFileFacts>>()

export function getSourceFileFacts(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): SourceFileFacts {
    const cacheKey = sourceFileFactsCacheKey(options)
    const cached   = sourceFileFactsCache.get(sourceFile)?.get(cacheKey)

    if (cached !== undefined) {
        return cached
    }

    const facts           = collectSourceFileFacts(tsInstance, sourceFile, options)
    const cachedByOptions = sourceFileFactsCache.get(sourceFile) ?? new Map<string, SourceFileFacts>()

    cachedByOptions.set(cacheKey, facts)
    sourceFileFactsCache.set(sourceFile, cachedByOptions)

    return facts
}

function collectSourceFileFacts(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): SourceFileFacts {
    const mixinDecoratorImports  = collectMixinDecoratorImports(tsInstance, sourceFile, options)
    const imports: ImportFacts[] = []
    const classes: ClassFacts[]  = []
    const classesByName          = new Map<string, ClassFacts>()
    const classesByDeclaration   = new Map<ts.ClassDeclaration, ClassFacts>()

    for (const statement of sourceFile.statements) {
        if (tsInstance.isImportDeclaration(statement) && tsInstance.isStringLiteral(statement.moduleSpecifier)) {
            imports.push(importFacts(tsInstance, statement))
            continue
        }

        if (!tsInstance.isClassDeclaration(statement)) {
            continue
        }

        const facts = classFacts(tsInstance, statement, mixinDecoratorImports, options)

        classes.push(facts)
        classesByDeclaration.set(statement, facts)

        if (facts.name !== undefined) {
            classesByName.set(facts.name, facts)
        }
    }

    return {
        mixinDecoratorImports,
        imports,
        classes,
        classesByName,
        classesByDeclaration
    }
}

function importFacts(
    tsInstance: TypeScript,
    declaration: ts.ImportDeclaration
): ImportFacts {
    const importClause  = declaration.importClause
    const namedBindings = importClause?.namedBindings
    const localNames    = [
        ...(importClause?.name === undefined ? [] : [ importClause.name.text ]),
        ...(namedBindings !== undefined && tsInstance.isNamedImports(namedBindings)
            ? namedBindings.elements.map((element) => element.name.text)
            : [])
    ]

    return {
        declaration,
        specifier : (declaration.moduleSpecifier as ts.StringLiteral).text,
        localNames
    }
}

type ClassMemberFacts = {
    staticNames      : Set<string>,
    configProperties : ConfigProperty[]
}

function classFacts(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration,
    mixinDecoratorImports: MixinDecoratorImports,
    options: TransformOptions
): ClassFacts {
    const implementedTypes = implementsTypes(tsInstance, declaration)

    // staticNames and configProperties both require a walk over the class
    // members, and are only read for classes that turn out to be mixins,
    // consumers, or construction opt-ins. Defer them to a single shared
    // member pass, memoized so ordinary classes never get walked at all.
    let memberFacts: ClassMemberFacts | undefined
    const getMemberFacts = (): ClassMemberFacts => {
        if (memberFacts === undefined) {
            memberFacts = collectClassMemberFacts(tsInstance, declaration)
        }

        return memberFacts
    }

    return {
        declaration,
        name                      : declaration.name?.text,
        defaultExport             : hasModifier(tsInstance, declaration, tsInstance.SyntaxKind.DefaultKeyword),
        extendsType               : extendsClause(tsInstance, declaration)?.types[0],
        implementsTypes           : implementedTypes,
        implementsIdentifierNames : implementedTypes
            .map((heritageType) => heritageType.expression)
            .filter((expression): expression is ts.Identifier => tsInstance.isIdentifier(expression))
            .map((expression) => expression.text),
        requiredBaseName : requiredBaseIdentifierName(tsInstance, declaration),
        get configProperties() {
            return getMemberFacts().configProperties
        },
        get staticNames() {
            return getMemberFacts().staticNames
        },
        get hasStaticNew() {
            return getMemberFacts().staticNames.has("new")
        },
        hasMixinDecorator : hasMixinDecorator(tsInstance, declaration, mixinDecoratorImports, options)
    }
}

function collectClassMemberFacts(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration
): ClassMemberFacts {
    const staticNames                        = new Set<string>()
    const configProperties: ConfigProperty[] = []

    for (const member of declaration.members) {
        // Fetch modifiers once per member: getModifiers allocates, and the
        // checks below would otherwise call it up to four times each.
        const modifiers       = tsInstance.canHaveModifiers(member)
            ? tsInstance.getModifiers(member)
            : undefined
        const hasModifierKind = (kind: ts.SyntaxKind): boolean => {
            return modifiers?.some((modifier) => modifier.kind === kind) ?? false
        }

        if (hasModifierKind(tsInstance.SyntaxKind.StaticKeyword)) {
            if (member.name !== undefined) {
                const name = propertyNameText(tsInstance, member.name)

                if (name !== undefined) {
                    staticNames.add(name)
                }
            }

            continue
        }

        // A public SET accessor (set-only or the setter of a get/set pair) is assignable —
        // `.new`'s `Object.assign` fires its setter — so it is a construction config input,
        // keyed by its name and typed by the setter's parameter type. A get-only accessor
        // has no set accessor, so it is (correctly) never collected here. Accessors are
        // treated as optional config (there is no definite-assignment notion for them).
        if (tsInstance.isSetAccessorDeclaration(member) &&
            !hasModifierKind(tsInstance.SyntaxKind.PrivateKeyword) &&
            !hasModifierKind(tsInstance.SyntaxKind.ProtectedKeyword) &&
            hasModifierKind(tsInstance.SyntaxKind.PublicKeyword)
        ) {
            const name = propertyNameText(tsInstance, member.name)

            if (name !== undefined) {
                // Carry the setter's parameter type so the config field is typed by what the
                // setter accepts (which `.new`'s `Object.assign` invokes), not the getter
                // type a `Pick<Class, name>` would read for a split get/set accessor.
                configProperties.push({ name, optional: true, valueType: member.parameters[0]?.type })
            }

            continue
        }

        if (!tsInstance.isPropertyDeclaration(member) ||
            hasModifierKind(tsInstance.SyntaxKind.PrivateKeyword) ||
            hasModifierKind(tsInstance.SyntaxKind.ProtectedKeyword) ||
            !hasModifierKind(tsInstance.SyntaxKind.PublicKeyword)
        ) {
            continue
        }

        const name = propertyNameText(tsInstance, member.name)

        if (name !== undefined) {
            configProperties.push({
                name,
                optional : member.questionToken !== undefined
            })
        }
    }

    return {
        staticNames,
        configProperties : uniqueConfigProperties(configProperties)
    }
}

function sourceFileFactsCacheKey(options: TransformOptions): string {
    return [
        options.packageName,
        options.decoratorName
    ].join("|")
}
