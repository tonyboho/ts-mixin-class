import type * as ts from "typescript"
import {
    defaultTransformOptions,
    type MixinDecoratorImports,
    type TransformOptions
} from "./model.js"
import type { TypeScript } from "./util.js"

export function hasMixinDecorator(
    tsInstance: TypeScript,
    node: ts.HasDecorators,
    imports: MixinDecoratorImports,
    options: Partial<TransformOptions> = {}
): boolean {
    const resolvedOptions = {
        ...defaultTransformOptions,
        ...options
    }

    return tsInstance.getDecorators(node)?.some((decorator) => {
        return isMixinDecorator(tsInstance, decorator, imports, resolvedOptions)
    }) ?? false
}

function isMixinDecorator(
    tsInstance: TypeScript,
    decorator: ts.Decorator,
    imports: MixinDecoratorImports,
    options: TransformOptions
): boolean {
    const expression = decorator.expression

    if (tsInstance.isCallExpression(expression)) {
        return isMixinDecoratorExpression(tsInstance, expression.expression, imports, options)
    }

    return isMixinDecoratorExpression(tsInstance, expression, imports, options)
}

function isMixinDecoratorExpression(
    tsInstance: TypeScript,
    expression: ts.Expression,
    imports: MixinDecoratorImports,
    options: TransformOptions
): boolean {
    if (tsInstance.isIdentifier(expression)) {
        return imports.identifiers.has(expression.text)
    }

    if (!tsInstance.isPropertyAccessExpression(expression)) {
        return false
    }

    return tsInstance.isIdentifier(expression.expression) &&
        imports.namespaces.has(expression.expression.text) &&
        expression.name.text === options.decoratorName
}

export function collectMixinDecoratorImports(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    options: TransformOptions
): MixinDecoratorImports {
    const imports = {
        identifiers : new Set<string>(),
        namespaces  : new Set<string>()
    }

    for (const statement of sourceFile.statements) {
        if (!isPackageImport(tsInstance, statement, options)) {
            continue
        }

        const namedBindings = (statement as ts.ImportDeclaration).importClause?.namedBindings

        if (namedBindings === undefined) {
            continue
        }

        if (tsInstance.isNamespaceImport(namedBindings)) {
            imports.namespaces.add(namedBindings.name.text)
            continue
        }

        for (const element of namedBindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text

            if (importedName === options.decoratorName) {
                imports.identifiers.add(element.name.text)
            }
        }
    }

    return imports
}

export function isPackageImport(
    tsInstance: TypeScript,
    statement: ts.Statement,
    options: TransformOptions
): boolean {
    return tsInstance.isImportDeclaration(statement) &&
        tsInstance.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === options.packageName
}
