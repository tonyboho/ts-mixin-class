import type * as ts from "typescript"
import { collectMixinDecoratorImports, hasMixinDecorator } from "./decorators.js"
import { dottedExpressionText } from "./entity-name.js"
import {
    uniqueConfigProperties,
    type ClassScopeEntry,
    type ConfigProperty,
    type MixinDecoratorImports,
    type TransformOptions
} from "./model.js"
import { extendsClause, implementsTypes, requiredBaseIdentifierName } from "./heritage.js"
import { propertyNameText } from "./util.js"
import { hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

export type ImportFacts = {
    declaration   : ts.ImportDeclaration,
    specifier     : string,
    localNames    : string[],
    // The binding name of a NAMESPACE import (`import * as lib from "…"` → "lib") — kept
    // out of `localNames` (those are value/type names; the namespace is a container whose
    // MEMBERS are referenced through qualified names, e.g. `implements lib.Logger`).
    namespaceName : string | undefined
}

export type ClassFacts = {
    declaration               : ts.ClassDeclaration,
    name                      : string | undefined,
    defaultExport             : boolean,
    extendsType               : ts.ExpressionWithTypeArguments | undefined,
    implementsTypes           : ts.ExpressionWithTypeArguments[],
    implementsIdentifierNames : string[],
    // Dotted texts of QUALIFIED `implements` references (`implements lib.Logger` →
    // "lib.Logger") — all-identifier property-access chains only. Resolved through a
    // namespace import binding; disjoint from `implementsIdentifierNames`.
    implementsQualifiedNames  : string[],
    requiredBaseName          : string | undefined,
    configProperties          : ConfigProperty[],
    staticNames               : Set<string>,
    hasStaticNew              : boolean,
    hasMixinDecorator         : boolean
}

export type SourceFileFacts = {
    mixinDecoratorImports  : MixinDecoratorImports,
    imports                : ImportFacts[],
    classes                : ClassFacts[],
    classesByName          : Map<string, ClassFacts>,
    // Namespace-nested classes by their dotted path (`data.Model`) — resolvable BEFORE
    // expansion mutates namespace bodies in place. Pure namespace chains only: a class
    // inside a function/block has no qualified name.
    classesByQualifiedName : Map<string, ClassFacts>,
    classesByDeclaration   : Map<ts.ClassDeclaration, ClassFacts>,
    // Every NAMED class declaration (top-level and nested) by name, each with its
    // enclosing-scope range and depth — the index lexical mixin resolution
    // (`resolveLexicalMixinRef`) answers from in O(same-named entries), no tree walk.
    // Collected here because this pass already visits every class exactly once.
    classScopesByName      : Map<string, ClassScopeEntry[]>,
    // True when at least one class is declared below the top level (inside a function body,
    // block, or namespace). The driver only walks into nested statement lists when this is set,
    // so a file with only top-level classes keeps the original flat, top-level-only pass.
    hasNestedClasses       : boolean
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
    const classesByQualifiedName = new Map<string, ClassFacts>()
    const classesByDeclaration   = new Map<ts.ClassDeclaration, ClassFacts>()
    const classScopesByName      = new Map<string, ClassScopeEntry[]>()

    const addScopeEntry = (declaration: ts.ClassDeclaration, scope: ScopeRange): void => {
        const name = declaration.name?.text

        if (name === undefined) {
            return
        }

        const entries = classScopesByName.get(name) ?? []

        entries.push({ declaration, scopeStart: scope.start, scopeEnd: scope.end, depth: scope.depth })
        classScopesByName.set(name, entries)
    }

    const topLevelScope: ScopeRange = { start: 0, end: sourceFile.end, depth: 0 }

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
        addScopeEntry(statement, topLevelScope)

        if (facts.name !== undefined) {
            classesByName.set(facts.name, facts)
        }
    }

    // Nested class declarations (inside function bodies, blocks, namespaces) are indexed by
    // DECLARATION ONLY — deliberately NOT added to `classes` / `classesByName`. The cross-file
    // registry and base-name resolution iterate those two and must stay top-level-only (a nested
    // class is a local: it cannot be exported and must never enter the registry or shadow a
    // top-level base name by string). The driver still finds a nested class's facts through
    // `classesByDeclaration` to expand it in place. The same walk carries the current
    // enclosing-scope range down, feeding `classScopesByName`.
    let hasNestedClasses = false

    const indexNestedClasses = (node: ts.Node, scope: ScopeRange, namespacePath: string[] | undefined): void => {
        tsInstance.forEachChild(node, (child) => {
            const childScope = isScopeContainer(tsInstance, child)
                ? { start: child.pos, end: child.end, depth: scope.depth + 1 }
                : scope
            // The dotted path stays alive only through namespace links (`namespace a` /
            // the nested ModuleDeclaration of a dotted `namespace a.b`); any other scope
            // container (a function body, a block) breaks it.
            const childPath = tsInstance.isModuleDeclaration(child) && tsInstance.isIdentifier(child.name)
                ? namespacePath === undefined ? undefined : [ ...namespacePath, child.name.text ]
                : tsInstance.isModuleBlock(child) || !isScopeContainer(tsInstance, child)
                    ? namespacePath
                    : undefined

            if (tsInstance.isClassDeclaration(child) && !classesByDeclaration.has(child)) {
                hasNestedClasses = true

                const facts = classFacts(tsInstance, child, mixinDecoratorImports, options)

                classesByDeclaration.set(child, facts)
                addScopeEntry(child, childScope)

                if (childPath !== undefined && childPath.length > 0 && facts.name !== undefined) {
                    classesByQualifiedName.set([ ...childPath, facts.name ].join("."), facts)
                }
            }

            indexNestedClasses(child, childScope, childPath)
        })
    }

    // Walk from the FILE so a top-level namespace statement is itself visited as a
    // child and contributes its name to the dotted path of everything inside it.
    indexNestedClasses(sourceFile, topLevelScope, [])

    return {
        mixinDecoratorImports,
        imports,
        classes,
        classesByName,
        classesByQualifiedName,
        classesByDeclaration,
        classScopesByName,
        hasNestedClasses
    }
}

type ScopeRange = { start: number, end: number, depth: number }

// A node whose statement list is a lexical scope for class declarations. A CaseBlock is the
// scope of a whole `switch` — its clauses share one block scope, so the clauses themselves
// are NOT containers.
function isScopeContainer(tsInstance: TypeScript, node: ts.Node): boolean {
    return tsInstance.isBlock(node) || tsInstance.isModuleBlock(node) || tsInstance.isCaseBlock(node)
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
        specifier     : (declaration.moduleSpecifier as ts.StringLiteral).text,
        localNames,
        namespaceName : namedBindings !== undefined && tsInstance.isNamespaceImport(namedBindings)
            ? namedBindings.name.text
            : undefined
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
        implementsQualifiedNames : implementedTypes
            .map((heritageType) => heritageType.expression)
            .filter((expression) => tsInstance.isPropertyAccessExpression(expression))
            .map((expression) => dottedExpressionText(tsInstance, expression))
            .filter((dotted): dotted is string => dotted !== undefined),
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
            // A config key is REQUIRED only when the field carries a definite-assignment `!`
            // (`public id!: T`); every other public field is an optional config key. The `!`
            // reads as "supplied from outside" — exactly true for a value coming from `.new`'s
            // config — and lets the field omit an initializer without a strict-init error.
            configProperties.push({
                name,
                optional : member.exclamationToken === undefined
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

// Resolve an all-identifier QUALIFIED base reference (`data.Model`, arbitrarily deep)
// to the facts of a class declared in a LOCAL namespace of this file. Namespaces may
// be merged (several declarations of one name) and dotted (`namespace a.b {}`), so
// every matching module is searched. Cross-file qualified bases (namespace imports)
// are not resolved here — the caller falls through to its cross-file route.
export function qualifiedLocalClassFacts(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    expression: ts.Expression,
    facts: SourceFileFacts
): ClassFacts | undefined {
    void sourceFile

    const dotted = dottedExpressionText(tsInstance, expression)

    if (dotted === undefined || !dotted.includes(".")) {
        return undefined
    }

    return facts.classesByQualifiedName.get(dotted)
}
