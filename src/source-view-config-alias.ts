import type * as ts from "typescript"

import { deepCloneNode, scriptKindFromFileName } from "./util.js"
import type { TypeScript } from "./util.js"

// [PROTOTYPE] A generated `<Name>Config` alias is a synthetic sibling whose `.original` was
// set to the owning class (`positionConstructionConfigAlias`); a user `type X = …` resolves
// `getOriginalNode` to itself, so the class-original test isolates exactly the generated ones.
function isGeneratedConfigAlias(
    tsInstance: TypeScript,
    statement: ts.Statement
): statement is ts.TypeAliasDeclaration {
    return tsInstance.isTypeAliasDeclaration(statement) &&
        tsInstance.isClassDeclaration(tsInstance.getOriginalNode(statement))
}

// [PROTOTYPE] Source view preserves the original file text, so a generated `<Name>Config`
// alias has no real "<Name>Config" substring to read — TypeScript's alias display reads the
// name node's SOURCE TEXT, so a synthetic alias renders as `}`. Append each generated alias
// as REAL text past the original end and swap the synthetic alias nodes for the reparsed,
// real-positioned ones. Appending never shifts the [0, N) offsets, so user-code nodes stay
// correct; the alias name now reads natively (incl. generics, e.g. `BoxConfig<number>`). The
// trade-off: the appended region is live for the language service (find-references / rename /
// definition land there) — a paired LS plugin drops navigation spans past the document end.
export function appendGeneratedConfigAliasesAsRealText(
    tsInstance: TypeScript,
    transformed: ts.SourceFile,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
    fileName: string
): ts.SourceFile {
    const aliases = transformed.statements.filter(
        (statement): statement is ts.TypeAliasDeclaration => isGeneratedConfigAlias(tsInstance, statement)
    )

    if (aliases.length === 0) {
        return transformed
    }

    const printer      = tsInstance.createPrinter({ removeComments: true })
    const aliasText    = aliases
        .map((alias) => printer.printNode(
            tsInstance.EmitHint.Unspecified,
            deepCloneNode(tsInstance, alias),
            transformed
        ))
        .join("\n")
    const combinedText = `${transformed.text}\n${aliasText}\n`

    // Reparse the combined text purely to obtain the appended aliases with correct, real
    // positions in the [N, …) tail; its leading (re-parsed user) statements are discarded.
    const reparsed    = tsInstance.createSourceFile(
        fileName,
        combinedText,
        languageVersionOrOptions,
        true,
        scriptKindFromFileName(tsInstance, fileName)
    )
    const realAliases = reparsed.statements.slice(reparsed.statements.length - aliases.length)
    const aliasSet    = new Set<ts.Statement>(aliases)
    const kept        = transformed.statements.filter((statement) => !aliasSet.has(statement))
    const grafted     = tsInstance.factory.createNodeArray([ ...kept, ...realAliases ])

    tsInstance.setTextRange(grafted, { pos: kept[0]?.pos ?? 0, end: combinedText.length })

    const mutable = transformed as {
        text           : string,
        end            : number,
        lineMap?       : readonly number[],
        endOfFileToken : ts.Token<ts.SyntaxKind.EndOfFileToken>,
        statements     : ts.NodeArray<ts.Statement>
    }

    mutable.text    = combinedText
    mutable.end     = combinedText.length
    mutable.lineMap = undefined
    tsInstance.setTextRange(mutable.endOfFileToken, { pos: combinedText.length, end: combinedText.length })
    mutable.statements = grafted

    return transformed
}
