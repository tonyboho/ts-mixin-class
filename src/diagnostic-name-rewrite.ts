import type * as ts from "typescript"
import { C3LinearizationError, mergeC3Linearizations } from "./c3-linearization.js"
import { buildImportedNameMap } from "./import-map.js"
import { getSourceFileFacts } from "./source-file-facts.js"
import {
    implementsTypes,
    isDeclarationFileName,
    propertyNameText,
    registryKey,
    requiredBaseType,
    type CrossFileContext,
    type TransformOptions
} from "./model.js"
import { hasModifier } from "./util.js"
import type { TypeScript } from "./util.js"

// The checker's own messages sometimes embed a BASE-CLASS NAME, and after the transform that
// name is a generated artifact — `__X$base`/`__X$empty` (the emitted heritage), `typeof
// __X$class` (the factory's inner runtime class), `ClassStatics<typeof R>` (the factory
// parameter's statics constituent) — or a render of a COLLAPSED generated range in source
// view (`'}'`, `'typeof }'`, or the metadata-cast intersection text `'Machine & Greeter'`).
// The diagnostic itself is correct and correctly positioned; only the NAME in the text is
// wrong. This module rewrites the message at the `wrapProgramDiagnostics` seam, mapping the
// artifact back to what the USER wrote:
//
// - the OWNER of the member at the diagnostic span (the override family TS4113/4114/4117,
//   TS2416): the member name is read from the ORIGINAL file at the span, then looked up
//   through the class's mixin layers in C3 order (nearest first) and the real base chain —
//   the first declaring layer is the honest "base class" of the message;
// - with no owner (the member exists in no layer — TS4113), the user-level description of
//   the combined base: `RealBase & MixinA & MixinB`;
// - pure textual unwraps that need no resolution: `typeof __X$class` → `typeof X`,
//   `ClassStatics<typeof R>` → `typeof R`; the collapsed `'typeof }'` resolves to the
//   class's own base (`typeof R`).
//
// CONSERVATIVE by construction: quoted-name replacement fires only on exact artifact forms
// (`'__X$base'`, a `base class/type '…'` context for `'}'`, or the byte-exact combined
// intersection render), and only when a replacement was actually resolved — an unresolvable
// site keeps the checker's original text. A rewrite can make the redundant artifact TWIN of
// a diagnostic byte-identical to its correct sibling (TS2416 fires once against the user's
// `implements` reference and once against the generated heritage) — an exact-duplicate pass
// then collapses them.

// The last alternative admits the source-view INTERSECTION render (`base class
// 'Machine & Greeter'` — plain TS never names a class's base as an intersection, our
// metadata-cast render does). The gate may over-admit; the actual quoted-name replacement
// below stays exact-keyed, so an admitted-but-unmatched message passes through untouched.
const artifactPattern = /__\w+\$(?:base|empty|class)\b|ClassStatics<typeof \w+>|'\}'|'typeof \}'|base (?:class|type) '[^']*&[^']*'/

export function rewriteGeneratedNameDiagnostics<Diagnostic extends ts.Diagnostic>(
    tsInstance: TypeScript,
    diagnostics: Diagnostic[],
    originalProgram: ts.Program,
    crossFile: CrossFileContext | undefined,
    options: TransformOptions
): Diagnostic[] {
    let rewroteAny = false

    const rewritten = diagnostics.map((diagnostic) => {
        if (!messageMentionsArtifact(tsInstance, diagnostic.messageText)) {
            return diagnostic
        }

        const rewrite = rewriteDiagnostic(tsInstance, diagnostic, originalProgram, crossFile, options)

        if (rewrite !== diagnostic) {
            rewroteAny = true
        }

        return rewrite
    })

    return rewroteAny ? dropExactDuplicates(tsInstance, rewritten) : rewritten
}

function messageMentionsArtifact(
    tsInstance: TypeScript,
    message: string | ts.DiagnosticMessageChain
): boolean {
    return artifactPattern.test(tsInstance.flattenDiagnosticMessageText(message, "\n"))
}

function rewriteDiagnostic<Diagnostic extends ts.Diagnostic>(
    tsInstance: TypeScript,
    diagnostic: Diagnostic,
    originalProgram: ts.Program,
    crossFile: CrossFileContext | undefined,
    options: TransformOptions
): Diagnostic {
    // Resolve against the ORIGINAL (pre-transform) file: the emit plane remaps spans onto it,
    // and the source-view plane preserves original positions — so on both planes the span
    // reads the user's own class/member, with the user's heritage clauses intact.
    const originalFile = diagnostic.file === undefined
        ? undefined
        : originalProgram.getSourceFile(diagnostic.file.fileName)
    const resolution   = originalFile === undefined || diagnostic.start === undefined
        ? undefined
        : resolveSpanContext(tsInstance, originalFile, diagnostic.start, originalProgram, crossFile, options)
    const aliasAtSpan  = originalFile === undefined || diagnostic.start === undefined
        ? undefined
        : configAliasNameAtSpan(tsInstance, originalFile, diagnostic.start)

    const rewriteText = (text: string): string => {
        let out = text
            .replace(/typeof __(\w+)\$class\b/g, "typeof $1")
            .replace(/ClassStatics<typeof (\w+)>/g, "typeof $1")

        if (resolution === undefined) {
            return out
        }

        if (resolution.realBaseName !== undefined) {
            out = out.replaceAll("'typeof }'", `'typeof ${resolution.realBaseName}'`)
        }

        const replacement = resolution.ownerName ?? resolution.combinedDisplay

        if (replacement !== undefined) {
            out = out.replace(/'__\w+\$(?:base|empty)'/g, `'${replacement}'`)
            out = out.replace(/(base (?:class|type) )'\}'/g, `$1'${replacement}'`)

            if (resolution.combinedDisplay !== undefined && resolution.combinedDisplay !== replacement) {
                out = out.replace(
                    new RegExp(`(base (?:class|type) )'${escapeRegExp(resolution.combinedDisplay)}'`, "g"),
                    `$1'${replacement}'`
                )
            }
        }

        // A remaining bare-quoted `'}'` can be the collapsed NAME of a generated in-block
        // `<Name>Config` alias — a construction class in a NESTED scope keeps its alias in the
        // block (the append-real-text trick is position-safe only past the document end), so a
        // message printing the alias SYMBOL (e.g. TS2315 `Type '{0}' is not generic`) renders
        // it as `'}'`. The span sits on the user's own alias reference — the original text at
        // the span IS the real name. Only an UNAMBIGUOUS single occurrence is rewritten: two
        // `'}'` renders in one message could come from two different aliases.
        if (aliasAtSpan !== undefined && out.match(/'\}'/g)?.length === 1) {
            out = out.replace("'}'", `'${aliasAtSpan}'`)
        }

        return out
    }

    const messageText = rewriteMessage(diagnostic.messageText, rewriteText)

    if (messageText === diagnostic.messageText) {
        return diagnostic
    }

    return { ...diagnostic, messageText }
}

function rewriteMessage(
    message: string | ts.DiagnosticMessageChain,
    rewriteText: (text: string) => string
): string | ts.DiagnosticMessageChain {
    if (typeof message === "string") {
        return rewriteText(message)
    }

    const messageText = rewriteText(message.messageText)
    const next        = message.next?.map((chained) => rewriteMessage(chained, rewriteText) as ts.DiagnosticMessageChain)
    const changed     = messageText !== message.messageText ||
        (next?.some((chained, index) => chained !== message.next?.[index]) ?? false)

    return changed ? { ...message, messageText, next: next ?? message.next } : message
}

type SpanResolution = {
    // The layer that DECLARES the member at the span (a mixin, or a class up the real base
    // chain) — the honest name for the override family's "base class".
    ownerName       : string | undefined,
    realBaseName    : string | undefined,
    // The user-level description of the combined base (`RealBase & MixinA & …`) — the
    // fallback when no layer declares the member, and the exact-match key for the
    // source-view intersection render.
    combinedDisplay : string | undefined
}

function resolveSpanContext(
    tsInstance: TypeScript,
    originalFile: ts.SourceFile,
    position: number,
    originalProgram: ts.Program,
    crossFile: CrossFileContext | undefined,
    options: TransformOptions
): SpanResolution | undefined {
    const enclosingClass = findEnclosingClass(tsInstance, originalFile, position)

    if (enclosingClass === undefined) {
        return undefined
    }

    const layers          = resolveMixinLayers(tsInstance, originalFile, enclosingClass, originalProgram, crossFile, options)
    const realBase        = requiredBaseType(tsInstance, enclosingClass)
    const realBaseName    = realBase === undefined ? undefined : realBase.expression.getText(originalFile)
    const combinedParts   = [ ...(realBaseName === undefined ? [] : [ realBaseName ]), ...layers.directNames ]
    const combinedDisplay = combinedParts.length === 0 ? undefined : combinedParts.join(" & ")

    const member     = enclosingClass.members.find((candidate) => {
        return candidate.pos <= position && position < candidate.end
    })
    const memberName = member?.name === undefined ? undefined : propertyNameText(tsInstance, member.name)
    const ownerName  = member === undefined || memberName === undefined
        ? undefined
        : findMemberOwner(
            tsInstance,
            memberName,
            hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword),
            layers,
            enclosingClass,
            originalFile,
            originalProgram,
            crossFile,
            options
        )

    return { ownerName, realBaseName, combinedDisplay }
}

// The `<Name>Config` identifier at the span in the ORIGINAL file, accepted only when a class
// `<Name>` is declared in the same file (any scope depth — nested classes are the case that
// needs this) — the shape of a generated construction-config alias reference. Anything else
// (no identifier, no `Config` suffix, no owning class) resolves to undefined and the message
// passes through untouched.
function configAliasNameAtSpan(
    tsInstance: TypeScript,
    file: ts.SourceFile,
    position: number
): string | undefined {
    const text         = file.text
    const isIdentifier = (index: number): boolean => /[\w$]/.test(text.charAt(index))

    let start = position
    let end   = position

    while (start > 0 && isIdentifier(start - 1)) {
        start--
    }

    while (end < text.length && isIdentifier(end)) {
        end++
    }

    const identifier = text.slice(start, end)
    const className  = /^(.+?)Config_*$/.exec(identifier)?.[1]

    return className !== undefined && findClassByName(tsInstance, file, className) !== undefined
        ? identifier
        : undefined
}

function findEnclosingClass(
    tsInstance: TypeScript,
    file: ts.SourceFile,
    position: number
): ts.ClassDeclaration | undefined {
    let enclosing: ts.ClassDeclaration | undefined

    const visit = (node: ts.Node): void => {
        tsInstance.forEachChild(node, (child) => {
            if (child.pos <= position && position < child.end) {
                if (tsInstance.isClassDeclaration(child)) {
                    enclosing = child
                }

                visit(child)
            }
        })
    }

    visit(file)

    return enclosing
}

type MixinLayers = {
    // The class's direct mixin layers, LISTED order (nearest first), by local display name.
    directNames    : string[],
    // The same layers as registry keys, then C3-linearized over the registry dependency
    // graph — the exact nearest-first order the runtime chain has.
    linearizedKeys : string[]
}

function resolveMixinLayers(
    tsInstance: TypeScript,
    originalFile: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    originalProgram: ts.Program,
    crossFile: CrossFileContext | undefined,
    options: TransformOptions
): MixinLayers {
    const facts                 = getSourceFileFacts(tsInstance, originalFile, options)
    const importMap             = crossFile === undefined
        ? undefined
        : buildImportedNameMap(tsInstance, originalFile, crossFile.resolveModuleFileName, facts)
    const directNames: string[] = []
    const directKeys: string[]  = []

    for (const heritageType of implementsTypes(tsInstance, declaration)) {
        if (!tsInstance.isIdentifier(heritageType.expression)) {
            continue
        }

        const name     = heritageType.expression.text
        const sameFile = findClassByName(tsInstance, originalFile, name)
        const localKey = registryKey(originalFile.fileName, name)

        if (sameFile !== undefined && facts.classesByDeclaration.get(sameFile)?.hasMixinDecorator === true) {
            directNames.push(name)
            directKeys.push(localKey)
            continue
        }

        const imported    = importMap?.get(name)
        const importedKey = imported === undefined
            ? undefined
            : registryKey(imported.resolvedFileName, imported.importedName)

        if (importedKey !== undefined && crossFile?.registry.has(importedKey) === true) {
            directNames.push(name)
            directKeys.push(importedKey)
        }
    }

    return {
        directNames,
        linearizedKeys : linearizeLayerKeys(directKeys, crossFile)
    }
}

// C3 over registry keys, mirroring `linearizeDependencyKeys` but reading dependencies from
// the cross-file REGISTRY (the seam has no FileMixinContext). The program-wide
// `linearizationCache` is reused as the per-mixin memo — the transform has usually already
// populated it. A conflict (no C3 order) falls back to the listed order: the diagnostic
// name is cosmetic, and the conflict itself is reported separately (TS990007).
function linearizeLayerKeys(
    directKeys: string[],
    crossFile: CrossFileContext | undefined
): string[] {
    if (directKeys.length === 0) {
        return []
    }

    const cache = crossFile?.linearizationCache ?? new Map<string, string[]>()

    const linearizeKey = (key: string, seen: Set<string>): string[] => {
        const cached = cache.get(key)

        if (cached !== undefined) {
            return cached
        }

        if (seen.has(key)) {
            return [ key ]
        }

        seen.add(key)

        const dependencies = crossFile?.registry.get(key)?.dependencies ?? []
        const linearized   = dependencies.length === 0
            ? [ key ]
            : [ key, ...mergeKeySequences(
                [ ...dependencies.map((dependency) => linearizeKey(dependency, seen)), [ ...dependencies ] ],
                dependencies
            ) ]

        cache.set(key, linearized)

        return linearized
    }

    return mergeKeySequences(
        [ ...directKeys.map((key) => linearizeKey(key, new Set())), [ ...directKeys ] ],
        directKeys
    )
}

function mergeKeySequences(sequences: string[][], fallback: string[]): string[] {
    try {
        return mergeC3Linearizations(sequences)
    } catch (error) {
        if (error instanceof C3LinearizationError) {
            return [ ...fallback ]
        }

        throw error
    }
}

function findMemberOwner(
    tsInstance: TypeScript,
    memberName: string,
    isStatic: boolean,
    layers: MixinLayers,
    enclosingClass: ts.ClassDeclaration,
    originalFile: ts.SourceFile,
    originalProgram: ts.Program,
    crossFile: CrossFileContext | undefined,
    options: TransformOptions
): string | undefined {
    for (const key of layers.linearizedKeys) {
        const declaration = declarationByKey(tsInstance, key, originalProgram)

        if (declaration !== undefined && declaredMemberNames(tsInstance, declaration, isStatic).has(memberName)) {
            return keyDisplayName(key)
        }
    }

    // The real base CHAIN (the mixin layers sit above it): name the class that DECLARES the
    // member. An unresolvable link (dynamic base, unimported name) stops the walk.
    const seen  = new Set<ts.ClassDeclaration>([ enclosingClass ])
    let current = resolveBaseClass(tsInstance, originalFile, enclosingClass, originalProgram, crossFile, options)

    while (current !== undefined && !seen.has(current.declaration)) {
        seen.add(current.declaration)

        if (declaredMemberNames(tsInstance, current.declaration, isStatic).has(memberName)) {
            return current.declaration.name?.text
        }

        current = resolveBaseClass(tsInstance, current.file, current.declaration, originalProgram, crossFile, options)
    }

    return undefined
}

function keyDisplayName(key: string): string {
    return key.slice(key.lastIndexOf("::") + 2)
}

function declarationByKey(
    tsInstance: TypeScript,
    key: string,
    originalProgram: ts.Program
): ts.ClassDeclaration | ts.InterfaceDeclaration | undefined {
    const separator = key.lastIndexOf("::")

    if (separator < 0) {
        return undefined
    }

    const fileName = key.slice(0, separator)
    const name     = key.slice(separator + 2)
    const file     = originalProgram.getSourceFile(fileName)

    if (file === undefined) {
        return undefined
    }

    // A `.d.ts` mixin's instance members live on its published interface; a program mixin is
    // its class declaration.
    return isDeclarationFileName(fileName)
        ? findInterfaceByName(tsInstance, file, name) ?? findClassByName(tsInstance, file, name)
        : findClassByName(tsInstance, file, name)
}

function findClassByName(
    tsInstance: TypeScript,
    file: ts.SourceFile,
    name: string
): ts.ClassDeclaration | undefined {
    let found: ts.ClassDeclaration | undefined

    const visit = (node: ts.Node): void => {
        if (found !== undefined) {
            return
        }

        if (tsInstance.isClassDeclaration(node) && node.name?.text === name) {
            found = node

            return
        }

        tsInstance.forEachChild(node, visit)
    }

    visit(file)

    return found
}

function findInterfaceByName(
    tsInstance: TypeScript,
    file: ts.SourceFile,
    name: string
): ts.InterfaceDeclaration | undefined {
    for (const statement of file.statements) {
        if (tsInstance.isInterfaceDeclaration(statement) && statement.name.text === name) {
            return statement
        }
    }

    return undefined
}

function declaredMemberNames(
    tsInstance: TypeScript,
    declaration: ts.ClassDeclaration | ts.InterfaceDeclaration,
    isStatic: boolean
): Set<string> {
    const names = new Set<string>()

    if (tsInstance.isInterfaceDeclaration(declaration)) {
        // Interface members are the instance side; a `.d.ts` mixin's statics live on its
        // const's cast type and are not resolved here (the fallback display covers them).
        if (!isStatic) {
            for (const member of declaration.members) {
                const name = member.name === undefined ? undefined : propertyNameText(tsInstance, member.name)

                if (name !== undefined) {
                    names.add(name)
                }
            }
        }

        return names
    }

    for (const member of declaration.members) {
        if (hasModifier(tsInstance, member, tsInstance.SyntaxKind.StaticKeyword) !== isStatic) {
            continue
        }

        if (tsInstance.isConstructorDeclaration(member)) {
            // A parameter property declares a real instance member.
            if (!isStatic) {
                for (const parameter of member.parameters) {
                    if (tsInstance.isParameterPropertyDeclaration(parameter, member) &&
                        tsInstance.isIdentifier(parameter.name)
                    ) {
                        names.add(parameter.name.text)
                    }
                }
            }

            continue
        }

        const name = member.name === undefined ? undefined : propertyNameText(tsInstance, member.name)

        if (name !== undefined) {
            names.add(name)
        }
    }

    return names
}

function resolveBaseClass(
    tsInstance: TypeScript,
    file: ts.SourceFile,
    declaration: ts.ClassDeclaration,
    originalProgram: ts.Program,
    crossFile: CrossFileContext | undefined,
    options: TransformOptions
): { declaration: ts.ClassDeclaration, file: ts.SourceFile } | undefined {
    const base = requiredBaseType(tsInstance, declaration)

    if (base === undefined || !tsInstance.isIdentifier(base.expression)) {
        return undefined
    }

    const name     = base.expression.text
    const sameFile = findClassByName(tsInstance, file, name)

    if (sameFile !== undefined) {
        return { declaration: sameFile, file }
    }

    if (crossFile === undefined) {
        return undefined
    }

    const imported = buildImportedNameMap(
        tsInstance,
        file,
        crossFile.resolveModuleFileName,
        getSourceFileFacts(tsInstance, file, options)
    ).get(name)

    if (imported === undefined) {
        return undefined
    }

    const importedFile = originalProgram.getSourceFile(imported.resolvedFileName)
    const importedBase = importedFile === undefined
        ? undefined
        : findClassByName(tsInstance, importedFile, imported.importedName)

    return importedFile === undefined || importedBase === undefined
        ? undefined
        : { declaration: importedBase, file: importedFile }
}

function dropExactDuplicates<Diagnostic extends ts.Diagnostic>(
    tsInstance: TypeScript,
    diagnostics: Diagnostic[]
): Diagnostic[] {
    const seen = new Set<string>()

    return diagnostics.filter((diagnostic) => {
        if (diagnostic.file === undefined || diagnostic.start === undefined) {
            return true
        }

        const key = [
            diagnostic.file.fileName,
            diagnostic.start,
            diagnostic.length,
            diagnostic.code,
            tsInstance.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        ].join(" ")

        if (seen.has(key)) {
            return false
        }

        seen.add(key)

        return true
    })
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
