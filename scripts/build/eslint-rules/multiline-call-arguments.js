// Local rule: when a call's argument list spans multiple lines, format it like a block —
// every argument starts on its own line (one indent step past the line the call starts
// on) and the closing parenthesis sits alone under that line, mirroring how a closing
// `}` closes a multiline object/body. Single-line calls are untouched.
//
// `allowTrailingHug: true` additionally permits the classic callback/literal form where
// only the LAST argument spans lines and everything else (including the closing paren)
// hugs it: `t.it("name", (t) => { ... })`.
//
// The fixer rebuilds the whole argument region in one edit: arguments joined by
// `,\n<indent>`, and each moved argument's continuation lines re-indented by the same
// column delta as its first line — except lines inside multiline template literals,
// whose text must stay byte-exact. Comments floating between arguments (outside every
// argument's range) cannot be re-anchored safely, so such calls are reported without a fix.

const INDENT = 4

export default {
    meta: {
        type: "layout",
        fixable: "whitespace",
        schema: [ {
            type: "object",
            properties: { allowTrailingHug: { type: "boolean" } },
            additionalProperties: false
        } ],
        messages: {
            explode: "Multiline call: put every argument on its own line and the closing parenthesis on its own line."
        }
    },

    create(context) {
        const sourceCode       = context.sourceCode
        const allowTrailingHug = (context.options[0] ?? {}).allowTrailingHug === true

        function lineIndentColumn(line) {
            const text = sourceCode.lines[line - 1] ?? ""

            return text.length - text.trimStart().length
        }

        // Line ranges (inclusive) of multiline template literals inside `node`, whose
        // continuation lines must not be re-indented (their text is significant).
        function templateLineRanges(argument) {
            const ranges = []

            const visit = (node) => {
                if (node.type === "TemplateLiteral" && node.loc.start.line !== node.loc.end.line) {
                    ranges.push([ node.loc.start.line, node.loc.end.line ])
                }

                for (const key of Object.keys(node)) {
                    if (key === "parent") {
                        continue
                    }

                    const value = node[key]
                    const children = Array.isArray(value) ? value : [ value ]

                    for (const child of children) {
                        if (child !== null && typeof child === "object" && typeof child.type === "string") {
                            visit(child)
                        }
                    }
                }
            }

            visit(argument)

            return ranges
        }

        function shiftedArgumentText(argument, delta) {
            const text = sourceCode.getText(argument)

            if (delta === 0 || argument.loc.start.line === argument.loc.end.line) {
                return text
            }

            const frozen = templateLineRanges(argument)
            const lines  = text.split("\n")

            return lines.map((line, index) => {
                if (index === 0) {
                    return line
                }

                const absoluteLine = argument.loc.start.line + index

                if (frozen.some(([ from, to ]) => absoluteLine > from && absoluteLine <= to)) {
                    return line
                }

                if (delta > 0) {
                    return line.length === 0 ? line : " ".repeat(delta) + line
                }

                const removable = Math.min(-delta, line.length - line.trimStart().length)

                return line.slice(removable)
            }).join("\n")
        }

        function check(node) {
            const args = node.arguments

            if (args === undefined || args.length === 0) {
                return
            }

            const openParen  = sourceCode.getTokenBefore(args[0])
            const closeParen = sourceCode.getLastToken(node)

            if (openParen === null || openParen.value !== "(" || closeParen === null || closeParen.value !== ")") {
                return
            }

            // Single-line argument list: nothing to enforce.
            if (openParen.loc.end.line === closeParen.loc.start.line) {
                return
            }

            const lastArg = args[args.length - 1]

            if (allowTrailingHug &&
                args[0].loc.start.line === openParen.loc.end.line &&
                args.slice(0, -1).every((argument) => argument.loc.end.line === openParen.loc.end.line) &&
                lastArg.loc.start.line === openParen.loc.end.line &&
                closeParen.loc.start.line === lastArg.loc.end.line
            ) {
                return
            }

            const baseColumn     = lineIndentColumn(node.loc.start.line)
            const argumentColumn = baseColumn + INDENT

            const wellFormed = args[0].loc.start.line > openParen.loc.end.line &&
                args.every((argument, index) => {
                    return index === 0 || argument.loc.start.line > args[index - 1].loc.end.line
                }) &&
                closeParen.loc.start.line > lastArg.loc.end.line &&
                args.every((argument) => argument.loc.start.column === argumentColumn) &&
                closeParen.loc.start.column === baseColumn

            if (wellFormed) {
                return
            }

            // A comment between arguments (outside every argument's range) has no safe
            // anchor in the rebuilt list — report without a fix.
            const floatingComments = sourceCode.getCommentsInside(node).some((comment) => {
                return comment.range[0] > openParen.range[1] &&
                    comment.range[1] < closeParen.range[0] &&
                    !args.some((argument) => {
                        return comment.range[0] >= argument.range[0] && comment.range[1] <= argument.range[1]
                    })
            })

            context.report({
                node,
                loc  : { start: openParen.loc.start, end: closeParen.loc.end },
                messageId : "explode",
                fix  : floatingComments ? null : (fixer) => {
                    const indent  = " ".repeat(argumentColumn)
                    const rebuilt = args.map((argument) => {
                        // Continuation lines are indented relative to the LINE the argument
                        // started on (the statement), not to the argument's own column —
                        // shift them by the change in that line base.
                        return indent + shiftedArgumentText(argument, argumentColumn - lineIndentColumn(argument.loc.start.line))
                    }).join(",\n")

                    return fixer.replaceTextRange(
                        [ openParen.range[1], closeParen.range[0] ],
                        "\n" + rebuilt + "\n" + " ".repeat(baseColumn)
                    )
                }
            })
        }

        return {
            CallExpression : check,
            NewExpression  : check
        }
    }
}
