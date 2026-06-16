import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, trimIndent } from "./util.js"
import { assertResponseBody, positionToLineOffset, runTypeScriptServerRequest } from "./tsserver-util.js"
import type { TsServerResponse } from "./tsserver-util.js"

export type TextPosition = {
    line : number,
    offset : number
}

export type TextSpan = {
    start : TextPosition,
    end : TextPosition
}

export type DefinitionInfo = TextSpan & {
    file : string
}

export type DefinitionAndBoundSpanBody = {
    definitions? : DefinitionInfo[]
}

export type QuickInfoBody = TextSpan & {
    displayString? : string
}

export type RenameResponseBody = {
    info? : {
        canRename? : boolean,
        displayName? : string
    },
    locs? : RenameFileLocation[]
}

export type RenameFileLocation = {
    file : string,
    locs : TextSpan[]
}

export const sourceText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class SourceMixin {
        static mixinStaticProperty: string = "mixin-static"

        static mixinStaticMethod(): string {
            return this.mixinStaticProperty
        }

        mixinProperty: string = "mixin"

        mixinMethod(): string {
            return this.mixinProperty
        }

        callOwnMethod(): string {
            return this.mixinMethod()
        }
    }

    @mixin()
    class ChildMixin implements SourceMixin {
        childMethod(): string {
            return super.mixinProperty
        }

        childCallMethod(): string {
            return super.mixinMethod()
        }
    }

    class PlainBase {
        static baseStaticProperty: number = 7

        static baseStaticMethod(): number {
            return this.baseStaticProperty
        }

        baseProperty: number = 42

        baseMethod(): number {
            return this.baseProperty
        }
    }

    class PlainConsumer extends PlainBase {
    }

    class MixinConsumer implements SourceMixin {
        readSuperProperty(): string {
            return super.mixinProperty
        }

        callSuperMethod(): string {
            return super.mixinMethod()
        }
    }

    const plain = new PlainConsumer()
    const mixed = new MixinConsumer()

    plain.baseProperty
    plain.baseMethod()
    mixed.mixinProperty
    mixed.mixinMethod()
    PlainConsumer.baseStaticProperty
    PlainConsumer.baseStaticMethod()
    MixinConsumer.mixinStaticProperty
    MixinConsumer.mixinStaticMethod()
`)

export const importedMixinText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class ImportedMixin {
        importedProperty: string = "imported"

        importedMethod(): string {
            return this.importedProperty
        }
    }
`)

export const importedConsumerText = trimIndent(`
    import { ImportedMixin } from "./mixins.js"

    class ImportedConsumer implements ImportedMixin {
        readImportedSuperProperty(): string {
            return super.importedProperty
        }

        callImportedSuperMethod(): string {
            return super.importedMethod()
        }
    }
`)

export const fixtureLikeMixinsText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    export class SourceClass1<A1> {
        value1: string = "value1"

        method1(): string {
            return this.value1
        }
    }

    @mixin()
    export class SourceClass2<A2> {
        value2: string = "value2"

        method2(): string {
            return this.value2
        }
    }
`)

export const fixtureLikeConsumerText = trimIndent(`
    import { SourceClass1, SourceClass2 } from "./mixins.js"

    class Base<T> {
        baseValue: T

        constructor(baseValue: T) {
            this.baseValue = baseValue
        }
    }

    class Consumer<A2> extends Base<A2> implements SourceClass1<string>, SourceClass2<A2> {
        method1(): string {
            this.value1 = "value1"
            super.value2 = "value2"

            return super.method1()
        }
    }
`)

export async function createEditorFixture(): Promise<{
    dispose : () => Promise<void>,
    sourceFile : string
}> {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : sourceText
            }
        ]
    })
    const sourceFile = fixture.sourceFiles.get("source.ts")

    if (sourceFile === undefined) {
        throw new Error("Missing fixture source file.")
    }

    return {
        dispose : fixture.dispose,
        sourceFile
    }
}

export async function assertDefinition(
    t: Test,
    sourceFile: string,
    memberName: string,
    declarationText: string,
    description: string,
    args = usageArgs(sourceFile, memberName)
): Promise<void> {
    const definitions = assertResponseBody<DefinitionInfo[]>(
        t,
        await request(sourceFile, "definition", args)
    )

    t.true(definitions.some((definition) => {
        return definition.file === sourceFile &&
            sourceSlice(sourceText, definition) === memberName &&
            sourceText.slice(positionToIndex(sourceText, definition.start)).startsWith(declarationText)
    }), `${description} usage resolves to its source declaration`)
}

export async function assertImportedDefinition(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const definitions = assertResponseBody<DefinitionInfo[]>(
        t,
        await importedRequest(sourceFile, "definition", args)
    )

    t.true(definitions.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(importedMixinText, definition) === memberName &&
            importedMixinText.slice(positionToIndex(importedMixinText, definition.start)).startsWith(declarationText)
    }), `Imported ${memberName} usage resolves to its source declaration`)
}

export async function assertFixtureLikeDefinition(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const definitions = assertResponseBody<DefinitionInfo[]>(
        t,
        await requestWithSourceText(sourceFile, fixtureLikeConsumerText, "definition", args)
    )

    t.true(definitions.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(fixtureLikeMixinsText, definition) === memberName &&
            fixtureLikeMixinsText.slice(positionToIndex(fixtureLikeMixinsText, definition.start)).startsWith(declarationText)
    }), `Fixture-like ${memberName} usage resolves to its source declaration`)
}

export async function assertDefinitionAndBoundSpan(
    t: Test,
    sourceFile: string,
    memberName: string,
    declarationText: string,
    description: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const body = assertResponseBody<DefinitionAndBoundSpanBody>(
        t,
        await request(sourceFile, "definitionAndBoundSpan", args)
    )

    t.true(body.definitions?.some((definition) => {
        return definition.file === sourceFile &&
            sourceSlice(sourceText, definition) === memberName &&
            sourceText.slice(positionToIndex(sourceText, definition.start)).startsWith(declarationText)
    }) === true, `${description} quick definition resolves to its source declaration`)
}

export async function assertImportedDefinitionAndBoundSpan(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const body = assertResponseBody<DefinitionAndBoundSpanBody>(
        t,
        await importedRequest(sourceFile, "definitionAndBoundSpan", args)
    )

    t.true(body.definitions?.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(importedMixinText, definition) === memberName &&
            importedMixinText.slice(positionToIndex(importedMixinText, definition.start)).startsWith(declarationText)
    }) === true, `Imported ${memberName} quick definition resolves to its source declaration`)
}

export async function assertFixtureLikeDefinitionAndBoundSpan(
    t: Test,
    sourceFile: string,
    mixinFile: string,
    memberName: string,
    declarationText: string,
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const body = assertResponseBody<DefinitionAndBoundSpanBody>(
        t,
        await requestWithSourceText(sourceFile, fixtureLikeConsumerText, "definitionAndBoundSpan", args)
    )

    t.true(body.definitions?.some((definition) => {
        return definition.file === mixinFile &&
            sourceSlice(fixtureLikeMixinsText, definition) === memberName &&
            fixtureLikeMixinsText.slice(positionToIndex(fixtureLikeMixinsText, definition.start)).startsWith(declarationText)
    }) === true, `Fixture-like ${memberName} quick definition resolves to its source declaration`)
}

export async function assertQuickInfo(
    t: Test,
    sourceFile: string,
    memberName: string,
    expectedParts: string[],
    args = usageArgs(sourceFile, memberName)
): Promise<void> {
    const quickInfo = assertResponseBody<QuickInfoBody>(
        t,
        await request(sourceFile, "quickinfo", args)
    )

    assertQuickInfoParts(t, quickInfo.displayString, expectedParts, `Missing quickinfo for ${memberName}`)
}

export async function assertImportedQuickInfo(
    t: Test,
    sourceFile: string,
    expectedParts: string[],
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const quickInfo = assertResponseBody<QuickInfoBody>(
        t,
        await importedRequest(sourceFile, "quickinfo", args)
    )

    assertQuickInfoParts(t, quickInfo.displayString, expectedParts, "Missing imported quickinfo")
}

export async function assertFixtureLikeQuickInfo(
    t: Test,
    sourceFile: string,
    expectedParts: string[],
    args: { file: string, line: number, offset: number }
): Promise<void> {
    const quickInfo = assertResponseBody<QuickInfoBody>(
        t,
        await requestWithSourceText(sourceFile, fixtureLikeConsumerText, "quickinfo", args)
    )

    assertQuickInfoParts(t, quickInfo.displayString, expectedParts, "Missing fixture-like quickinfo")
}

function assertQuickInfoParts(
    t: Test,
    displayString: string | undefined,
    expectedParts: string[],
    missingMessage: string
): void {
    t.not.isStrict(displayString, undefined, missingMessage)

    if (displayString === undefined) {
        return
    }

    for (const expectedPart of expectedParts) {
        t.match(displayString, expectedPart, `Quick info includes ${expectedPart}`)
    }
}

export async function request(sourceFile: string, command: string, args: unknown): Promise<TsServerResponse> {
    return requestWithSourceText(sourceFile, sourceText, command, args)
}

async function importedRequest(sourceFile: string, command: string, args: unknown): Promise<TsServerResponse> {
    return requestWithSourceText(sourceFile, importedConsumerText, command, args)
}

async function requestWithSourceText(
    sourceFile: string,
    text: string,
    command: string,
    args: unknown
): Promise<TsServerResponse> {
    return runTypeScriptServerRequest(
        sourceFile.slice(0, sourceFile.lastIndexOf("/")),
        sourceFile,
        text,
        command,
        args
    )
}

export function usageArgs(sourceFile: string, memberName: string): { file: string, line: number, offset: number } {
    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, memberUsagePosition(memberName))
    }
}

export function selfMixinPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    const accessText = "this.mixinProperty"
    const position   = sourceText.indexOf(accessText)

    if (position < 0) {
        throw new Error("Cannot find mixin self property usage.")
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, position + "this.".length + 1)
    }
}

export function superMixinPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    const accessText = "super.mixinProperty"
    const position   = sourceText.indexOf(accessText)

    if (position < 0) {
        throw new Error("Cannot find mixin super property usage.")
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(sourceText, position + "super.".length + 1)
    }
}

export function selfMixinMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "this.mixinMethod", "this.")
}

export function selfMixinStaticPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "this.mixinStaticProperty", "this.", "static mixinStaticMethod(): string")
}

export function superMixinMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "super.mixinMethod", "super.")
}

export function consumerSuperMixinPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "super.mixinProperty", "super.", "readSuperProperty(): string")
}

export function consumerSuperMixinMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return accessArgs(sourceFile, "super.mixinMethod", "super.", "callSuperMethod(): string")
}

export function importedConsumerSuperPropertyArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        importedConsumerText,
        sourceFile,
        "super.importedProperty",
        "super.",
        "readImportedSuperProperty(): string"
    )
}

export function importedConsumerSuperMethodArgs(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        importedConsumerText,
        sourceFile,
        "super.importedMethod",
        "super.",
        "callImportedSuperMethod(): string"
    )
}

export function fixtureLikeSuperValue2Args(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        fixtureLikeConsumerText,
        sourceFile,
        "super.value2",
        "super.",
        "method1(): string"
    )
}

export function fixtureLikeSuperMethod1Args(sourceFile: string): { file: string, line: number, offset: number } {
    return sourceAccessArgs(
        fixtureLikeConsumerText,
        sourceFile,
        "super.method1",
        "super.",
        "return super.method1()"
    )
}

function accessArgs(
    sourceFile: string,
    accessText: string,
    receiver: string,
    containingText?: string
): { file: string, line: number, offset: number } {
    return sourceAccessArgs(sourceText, sourceFile, accessText, receiver, containingText)
}

function sourceAccessArgs(
    source: string,
    sourceFile: string,
    accessText: string,
    receiver: string,
    containingText?: string
): { file: string, line: number, offset: number } {
    const containingPosition = containingText === undefined ? 0 : source.indexOf(containingText)

    if (containingPosition < 0) {
        throw new Error(`Cannot find containing text: ${containingText}`)
    }

    const position = source.indexOf(accessText, containingPosition)

    if (position < 0) {
        throw new Error(`Cannot find access: ${accessText}`)
    }

    return {
        file : sourceFile,
        ...positionToLineOffset(source, position + receiver.length + 1)
    }
}

function memberUsagePosition(memberName: string): number {
    const receivers = [ "plain", "mixed", "PlainConsumer", "MixinConsumer" ]

    for (const receiver of receivers) {
        const accessText = `${receiver}.${memberName}`
        const position   = sourceText.indexOf(accessText)

        if (position >= 0) {
            return position + receiver.length + 1 + 1
        }
    }

    throw new Error(`Cannot find member usage: ${memberName}`)
}

export function assertRenameAllowed(
    t: Test,
    response: TsServerResponse,
    sourceFile: string,
    displayName: string,
    nextName: string
): string {
    const body = assertResponseBody<RenameResponseBody>(t, response)

    t.equal(response.command, "rename", "Response belongs to the rename command")
    t.true(body.info?.canRename, JSON.stringify(response.body))
    t.equal(body.info?.displayName, displayName, "Rename info points at the source symbol")
    t.true(Array.isArray(body.locs) && body.locs.length > 0, "Rename response contains rename locations")

    return applyRenameLocations(sourceFile, body.locs ?? [], nextName)
}

function applyRenameLocations(
    sourceFile: string,
    fileLocations: RenameFileLocation[],
    nextName: string
): string {
    const edits = fileLocations
        .filter((fileLocation) => fileLocation.file === sourceFile)
        .flatMap((fileLocation) => fileLocation.locs)
        .map((location) => {
            return {
                start : positionToIndex(sourceText, location.start),
                end   : positionToIndex(sourceText, location.end)
            }
        })
        .sort((left, right) => right.start - left.start)

    let nextSource = sourceText

    for (const edit of edits) {
        nextSource = `${nextSource.slice(0, edit.start)}${nextName}${nextSource.slice(edit.end)}`
    }

    return nextSource
}

export function sourceSlice(source: string, span: TextSpan): string {
    return source.slice(positionToIndex(source, span.start), positionToIndex(source, span.end))
}

export function positionToIndex(source: string, position: TextPosition): number {
    const lines = source.split("\n")
    const beforeLine = lines
        .slice(0, position.line - 1)
        .reduce((sum, line) => sum + line.length + 1, 0)

    return beforeLine + position.offset - 1
}
