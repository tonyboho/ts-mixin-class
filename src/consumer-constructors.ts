import type * as ts from "typescript"
import { generatedTextRange, preserveTextRange } from "./text-range.js"
import type { TypeScript } from "./util.js"

export function addSyntheticSuperCallToConstructors(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    members: ts.NodeArray<ts.ClassElement>,
    shouldAdd: boolean
): ts.NodeArray<ts.ClassElement> {
    if (!shouldAdd) {
        return members
    }

    let changed          = false
    const updatedMembers = members.map((member) => {
        if (!tsInstance.isConstructorDeclaration(member) ||
            member.body === undefined ||
            constructorHasSuperCall(tsInstance, member)
        ) {
            return member
        }

        changed = true

        return tsInstance.factory.updateConstructorDeclaration(
            member,
            member.modifiers,
            member.parameters,
            tsInstance.factory.updateBlock(member.body, [
                syntheticSuperCall(tsInstance, sourceFile, member),
                ...member.body.statements
            ])
        )
    })

    return changed
        ? preserveTextRange(tsInstance, tsInstance.factory.createNodeArray(updatedMembers), members)
        : members
}

function constructorHasSuperCall(
    tsInstance: TypeScript,
    declaration: ts.ConstructorDeclaration
): boolean {
    return declaration.body?.statements.some((statement) => {
        return tsInstance.isExpressionStatement(statement) &&
            tsInstance.isCallExpression(statement.expression) &&
            statement.expression.expression.kind === tsInstance.SyntaxKind.SuperKeyword
    }) ?? false
}

function syntheticSuperCall(
    tsInstance: TypeScript,
    sourceFile: ts.SourceFile,
    declaration: ts.ConstructorDeclaration
): ts.Statement {
    return preserveTextRange(
        tsInstance,
        tsInstance.factory.createExpressionStatement(tsInstance.factory.createCallExpression(
            tsInstance.factory.createSuper(),
            undefined,
            []
        )),
        generatedTextRange(sourceFile, declaration.body?.statements.pos ?? declaration.pos)
    )
}
