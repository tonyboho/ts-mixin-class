// ts-mixin-class language-service plugin.
//
// The program transform appends each generated `<Name>Config` alias as REAL text past the
// end of the source-view file, so the checker can read the real alias name (diagnostics,
// hover, quickinfo — including generics). That appended tail is LIVE for the language
// service, so go-to-definition / find-references / rename / document-highlights would return
// phantom spans inside it, at positions past the real (on-disk) document end.
//
// This plugin decorates the language service by overriding the navigation methods IN PLACE
// (a plain wrapper — it mutates and returns the same object, no `Proxy` and no per-call copy):
//   - find-references / rename / document-highlights DROP any span that starts at or past the
//     real document length (the script-snapshot length, i.e. the on-disk file, NOT the
//     transform's appended text) — that is exactly the phantom tail, a deterministic filter;
//   - go-to-definition / type-definition / implementation REMAP a phantom hit (a jump onto the
//     synthetic `<Name>Config` declaration in the tail) back to the owning class' name, so the
//     user lands on the real class instead of nowhere.
//
// Compiled to CommonJS (`tsconfig.lsplugin.json`) because tsserver loads plugins via `require`
// and ignores the package `exports` map (it resolves `<name>/package.json` -> `main`).

// INVARIANT: this plugin must use the SAME typescript instance tsserver runs — the one handed to
// us as `modules.typescript` — never a separately-loaded copy (a second instance means mismatched
// enums / `instanceof` / version). So `ts` is a TYPE-ONLY import, used only for annotations
// (`ts.server.*`, `ts.LanguageService`, …): using it as a runtime VALUE is then a COMPILE ERROR,
// which enforces the invariant. The runtime instance's type is `typeof import("typescript")`.
import type * as ts from "typescript"

function init(modules: { typescript: typeof import("typescript") }): ts.server.PluginModule {
    const tsInstance = modules.typescript

    function create(info: ts.server.PluginCreateInfo): ts.LanguageService {
        const ls   = info.languageService
        const host = info.languageServiceHost

        const documentLength = (fileName: string): number => {
            const snapshot = host.getScriptSnapshot ? host.getScriptSnapshot(fileName) : undefined

            return snapshot ? snapshot.getLength() : Number.MAX_SAFE_INTEGER
        }

        // A navigation span is real when it starts within the on-disk document.
        const isReal = (span: ts.DocumentSpan): boolean =>
            span.textSpan.start < documentLength(span.fileName)

        // The owning class' name span for a generated alias name (`<Name>Config` -> `<Name>`,
        // allowing the `_`-suffixed collision form), resolved against the real class
        // declaration in the document (before the appended tail). Undefined when no such class
        // is found (e.g. the hit was not one of our aliases) — the caller then drops it.
        const classNameSpanForAlias = (fileName: string, aliasName: string): ts.TextSpan | undefined => {
            const className = aliasName.replace(/Config_*$/, "")

            if (className === "" || className === aliasName) {
                return undefined
            }

            const sourceFile = ls.getProgram()?.getSourceFile(fileName)

            if (sourceFile === undefined) {
                return undefined
            }

            const limit = documentLength(fileName)
            let   span: ts.TextSpan | undefined

            const visit = (node: ts.Node): void => {
                if (span !== undefined) {
                    return
                }

                if (tsInstance.isClassDeclaration(node) && node.name?.text === className) {
                    const start = node.name.getStart(sourceFile)

                    if (start < limit) {
                        span = { start, length: node.name.getEnd() - start }

                        return
                    }
                }

                node.forEachChild(visit)
            }

            sourceFile.forEachChild(visit)

            return span
        }

        // A jump-to-declaration result: keep it if real, else remap a phantom alias hit to its
        // owning class, else drop it.
        const remapDefinition = (definition: ts.DefinitionInfo): ts.DefinitionInfo | undefined => {
            if (definition.textSpan.start < documentLength(definition.fileName)) {
                return definition
            }

            const span = classNameSpanForAlias(definition.fileName, definition.name)

            if (span === undefined) {
                return undefined
            }

            return {
                ...definition,
                textSpan      : span,
                contextSpan   : span,
                kind          : tsInstance.ScriptElementKind.classElement,
                containerName : ""
            }
        }

        const remapDefinitions = (
            definitions: readonly ts.DefinitionInfo[] | undefined
        ): ts.DefinitionInfo[] | undefined =>
            definitions?.map(remapDefinition).filter((definition): definition is ts.DefinitionInfo =>
                definition !== undefined)

        // --- jump-to-declaration: remap phantom hits onto the owning class ---

        const baseGetDefinitionAtPosition = ls.getDefinitionAtPosition.bind(ls)
        ls.getDefinitionAtPosition = (fileName, position) =>
            remapDefinitions(baseGetDefinitionAtPosition(fileName, position))

        const baseGetDefinitionAndBoundSpan = ls.getDefinitionAndBoundSpan.bind(ls)
        ls.getDefinitionAndBoundSpan = (fileName, position) => {
            const result = baseGetDefinitionAndBoundSpan(fileName, position)

            return result?.definitions !== undefined
                ? { ...result, definitions: remapDefinitions(result.definitions) }
                : result
        }

        const baseGetTypeDefinitionAtPosition = ls.getTypeDefinitionAtPosition.bind(ls)
        ls.getTypeDefinitionAtPosition = (fileName, position) =>
            remapDefinitions(baseGetTypeDefinitionAtPosition(fileName, position))

        // Implementation locations carry no alias name to remap from, so a phantom hit is just
        // dropped (go-to-implementation never targets a synthetic config alias in practice).
        const baseGetImplementationAtPosition = ls.getImplementationAtPosition.bind(ls)
        ls.getImplementationAtPosition = (fileName, position) =>
            baseGetImplementationAtPosition(fileName, position)?.filter(isReal)

        // --- all-occurrences: drop phantom spans in the appended tail ---

        const baseGetReferencesAtPosition = ls.getReferencesAtPosition.bind(ls)
        ls.getReferencesAtPosition = (fileName, position) =>
            baseGetReferencesAtPosition(fileName, position)?.filter(isReal)

        const baseFindReferences = ls.findReferences.bind(ls)
        ls.findReferences = (fileName, position) =>
            baseFindReferences(fileName, position)
                ?.map((symbol) => ({ ...symbol, references: symbol.references.filter(isReal) }))
                .filter((symbol) => symbol.references.length > 0)

        const baseFindRenameLocations = ls.findRenameLocations.bind(ls) as (
            ...args: unknown[]
        ) => readonly ts.RenameLocation[] | undefined
        ls.findRenameLocations = ((...args: unknown[]) =>
            baseFindRenameLocations(...args)?.filter(isReal)) as ts.LanguageService["findRenameLocations"]

        const baseGetDocumentHighlights = ls.getDocumentHighlights.bind(ls)
        ls.getDocumentHighlights = (fileName, position, filesToSearch) =>
            baseGetDocumentHighlights(fileName, position, filesToSearch)
                ?.map((entry) => ({
                    ...entry,
                    highlightSpans: entry.highlightSpans.filter(
                        (span) => span.textSpan.start < documentLength(entry.fileName)
                    )
                }))
                .filter((entry) => entry.highlightSpans.length > 0)

        // --- quickinfo: name a NESTED class's generated `<Name>Config` alias ---
        //
        // A top-level generated alias is appended as REAL text past the document end, so its
        // name renders natively. A construction class in a NESTED scope keeps its alias INSIDE
        // the block (appending real text is position-safe only past the end), so the alias
        // hover prints the collapsed name — `type } = {...}`. The hovered token IS the alias
        // reference, so its text is the real name: substitute it into the collapsed `aliasName`
        // display parts, gated on the `<Name>Config` shape with an owning class present (the
        // same resolution the definition remap uses).
        const identifierAtPosition = (fileName: string, position: number): string | undefined => {
            const snapshot = host.getScriptSnapshot ? host.getScriptSnapshot(fileName) : undefined

            if (snapshot === undefined) {
                return undefined
            }

            const length       = snapshot.getLength()
            const isIdentifier = (index: number): boolean => /[\w$]/.test(snapshot.getText(index, index + 1))

            let start = position
            let end   = position

            while (start > 0 && isIdentifier(start - 1)) {
                start--
            }

            while (end < length && isIdentifier(end)) {
                end++
            }

            return start < end ? snapshot.getText(start, end) : undefined
        }

        const isCollapsedAliasName = (part: ts.SymbolDisplayPart): boolean =>
            part.kind === "aliasName" && part.text === "}"

        const baseGetQuickInfoAtPosition = ls.getQuickInfoAtPosition.bind(ls)
        ls.getQuickInfoAtPosition = (fileName, position) => {
            const result = baseGetQuickInfoAtPosition(fileName, position)

            if (result?.displayParts?.some(isCollapsedAliasName) !== true) {
                return result
            }

            const aliasName = identifierAtPosition(fileName, position)

            if (aliasName === undefined || classNameSpanForAlias(fileName, aliasName) === undefined) {
                return result
            }

            return {
                ...result,
                displayParts : result.displayParts?.map((part) =>
                    isCollapsedAliasName(part) ? { ...part, text: aliasName } : part)
            }
        }

        // --- quickinfo / signature help / completion details: name the generated `.new` ---
        //
        // The generated `static new`'s NAME node is pinned to a ONE-CHAR source anchor (a
        // factory-fresh name crashes the checker's error-span machinery on a failing
        // `.new(...)` call — see `createConstructionMembers`), so member-name display reads
        // that single source character instead: `TopPoint.r` / `Point[}]` on hover, `r(` in
        // signature help, the same render in completion details (a mixin's string-literal
        // `"new"` collapses to a non-identifier char and falls back to the bracketed form).
        // The real name is statically `new`, and each surface's request provably targets it —
        // the hovered identifier, the callee before the arguments span, or the requested
        // completion entry — so the first mis-rendered method-name part is normalized. A
        // user-declared `static new` renders its own real text and the normalization no-ops.

        const renameNewParts = (parts: ts.SymbolDisplayPart[] | undefined): ts.SymbolDisplayPart[] | undefined => {
            if (parts === undefined) {
                return parts
            }

            const out: ts.SymbolDisplayPart[] = []
            let   renamed = false

            for (let index = 0; index < parts.length; index++) {
                const part = parts[index]

                if (part === undefined) {
                    continue
                }

                if (!renamed && part.kind === "methodName" && part.text !== "new") {
                    out.push({ kind: "methodName", text: "new" })
                    renamed = true
                    continue
                }

                // The bracketed render (`Timed[0]`) of the string-literal `"new"` name:
                // normalize the whole `[x]` back to `.new`.
                if (!renamed &&
                    part.kind === "punctuation" && part.text === "[" &&
                    parts[index + 2]?.kind === "punctuation" && parts[index + 2]?.text === "]" &&
                    parts[index + 3]?.text === "("
                ) {
                    out.push({ kind: "punctuation", text: "." }, { kind: "methodName", text: "new" })
                    index  += 2
                    renamed = true
                    continue
                }

                out.push(part)
            }

            return renamed ? out : parts
        }

        // The identifier just before an invocation's arguments span (skipping the open paren
        // and whitespace) — the callee name a signature-help request is showing.
        const calleeBeforeSpan = (fileName: string, spanStart: number): string | undefined => {
            const snapshot = host.getScriptSnapshot ? host.getScriptSnapshot(fileName) : undefined

            if (snapshot === undefined) {
                return undefined
            }

            const charAt = (index: number): string => snapshot.getText(index, index + 1)

            let end = spanStart

            while (end > 0 && /[\s(]/.test(charAt(end - 1))) {
                end--
            }

            let start = end

            while (start > 0 && /[\w$]/.test(charAt(start - 1))) {
                start--
            }

            return start < end ? snapshot.getText(start, end) : undefined
        }

        const baseQuickInfoForNewName = ls.getQuickInfoAtPosition.bind(ls)
        ls.getQuickInfoAtPosition = (fileName, position) => {
            const result = baseQuickInfoForNewName(fileName, position)

            if (result?.displayParts === undefined || identifierAtPosition(fileName, position) !== "new") {
                return result
            }

            const displayParts = renameNewParts(result.displayParts)

            return displayParts === result.displayParts ? result : { ...result, displayParts }
        }

        const baseGetSignatureHelpItems = ls.getSignatureHelpItems.bind(ls)
        ls.getSignatureHelpItems = (fileName, position, options) => {
            const result = baseGetSignatureHelpItems(fileName, position, options)

            if (result === undefined || calleeBeforeSpan(fileName, result.applicableSpan.start) !== "new") {
                return result
            }

            return {
                ...result,
                items : result.items.map((item) => {
                    const prefixDisplayParts = renameNewParts(item.prefixDisplayParts)

                    return prefixDisplayParts === item.prefixDisplayParts
                        ? item
                        : { ...item, prefixDisplayParts: prefixDisplayParts ?? item.prefixDisplayParts }
                })
            }
        }

        const baseGetCompletionEntryDetails = ls.getCompletionEntryDetails.bind(ls)
        ls.getCompletionEntryDetails = (fileName, position, entryName, formatOptions, source, preferences, data) => {
            const result = baseGetCompletionEntryDetails(
                fileName, position, entryName, formatOptions, source, preferences, data
            )

            if (result === undefined || entryName !== "new") {
                return result
            }

            const displayParts = renameNewParts(result.displayParts)

            return displayParts === result.displayParts ? result : { ...result, displayParts: displayParts ?? [] }
        }

        // --- completions: drop the generated helper names from identifier lists ---
        //
        // The source-view transform splices real declarations (`__X$base`, `__X$empty`, the
        // `__X$mixin` factory) into the scope of the class they expand, and imports the runtime
        // value helpers under reserved local aliases (`__defineMixinClass__`, …). They are bound,
        // so scope-level identifier completions offer them as phantom entries the user can
        // neither read nor meaningfully use. Same policy as the navigation-span filtering above:
        // what the transform generates never surfaces in the editor UI.
        const isGeneratedHelperName = (name: string): boolean =>
            /^__.+\$(base|empty|mixin)$/.test(name) ||
            /^(__defineMixinClass__|__mixinChain__|__mixinChainLinearized__|__mixinBase)$/.test(name)

        const baseGetCompletionsAtPosition = ls.getCompletionsAtPosition.bind(ls)
        ls.getCompletionsAtPosition = (fileName, position, options, formattingSettings) => {
            const result = baseGetCompletionsAtPosition(fileName, position, options, formattingSettings)

            return result === undefined
                ? result
                : { ...result, entries: result.entries.filter((entry) => !isGeneratedHelperName(entry.name)) }
        }

        return ls
    }

    return { create }
}

export = init
