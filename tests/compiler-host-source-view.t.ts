import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { createMixinClassCompilerHost } from "../src/index.js"
import type { MixinClassTransformerConfig } from "../src/index.js"
import { findClass, findVariable, trimIndent } from "./util.js"

const sourceFileName = "source.ts"

const sourceText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class SourceClass<T> {
        value: string = "value"

        passThrough(a: T): T {
            return a
        }
    }

    class Consumer<T> implements SourceClass<T> {
        ownMethod(): string {
            return "own"
        }
    }
`)

const preserveCompilerOptions: ts.CompilerOptions = {
    target                 : ts.ScriptTarget.ES2022,
    module                 : ts.ModuleKind.ESNext,
    moduleResolution       : ts.ModuleResolutionKind.Bundler,
    strict                 : true,
    skipLibCheck           : true,
    noEmit                 : true,
    experimentalDecorators : false
}

it("compiler host preserves source text in IDE mode while exposing transformed AST", async (t: Test) => {
    const host       = createMemoryCompilerHost(new Map([ [ sourceFileName, sourceText ] ]), preserveCompilerOptions)
    const sourceFile = getTransformedSourceFile(t, host, preserveCompilerOptions, {})

    t.equal(sourceFile.text, sourceText, "IDE/default noEmit mode keeps original source text")
    t.not.isStrict(findClass(sourceFile, "SourceClass"), undefined, "IDE AST keeps the original mixin class for editor navigation")
    t.isStrict(findVariable(sourceFile, "__SourceClass$mixin"), undefined, "IDE AST does not place a runtime factory over source ranges")
    t.not.isStrict(findClass(sourceFile, "__Consumer$empty"), undefined, "Transformed AST has a generated empty consumer base")
    t.not.isStrict(findClass(sourceFile, "__Consumer$base"), undefined, "Transformed AST has generated consumer base")

    const consumer = findClass(sourceFile, "Consumer")

    t.not.isStrict(consumer, undefined, "Transformed AST keeps the consumer class")
    t.equal(
        sourceFile.text.slice(consumer?.name?.getStart(sourceFile), consumer?.name?.getEnd()),
        "Consumer",
        "Original consumer identifier range still points at the original text"
    )
})

it('mode "ide" keeps original source text even when emit is enabled', async (t: Test) => {
    const emitOptions = {
        ...preserveCompilerOptions,
        noEmit : false
    }
    const host        = createMemoryCompilerHost(new Map([ [ sourceFileName, sourceText ] ]), emitOptions)
    const sourceFile  = getTransformedSourceFile(t, host, emitOptions, { mode: "ide" })

    t.equal(sourceFile.text, sourceText, 'mode "ide" keeps original source text')
    t.not.isStrict(findClass(sourceFile, "__Consumer$empty"), undefined, 'mode "ide" exposes the generated empty consumer base')
    t.not.isStrict(findClass(sourceFile, "__Consumer$base"), undefined, 'mode "ide" still exposes the consumer transform')
})

it('mode "emit" prints transformed source even when noEmit is set', async (t: Test) => {
    const host       = createMemoryCompilerHost(new Map([ [ sourceFileName, sourceText ] ]), preserveCompilerOptions)
    const sourceFile = getTransformedSourceFile(t, host, preserveCompilerOptions, { mode: "emit" })

    t.not.isStrict(sourceFile.text, sourceText, 'mode "emit" replaces the source text')
    t.match(sourceFile.text, "__SourceClass$mixin", 'mode "emit" source text contains generated declarations')
})

it("unknown mode option throws", async (t: Test) => {
    const host = createMemoryCompilerHost(new Map(), preserveCompilerOptions)

    let error: Error | undefined

    try {
        createMixinClassCompilerHost(
            ts,
            host,
            preserveCompilerOptions,
            { mode: "watch" } as unknown as MixinClassTransformerConfig
        )
    } catch (caught) {
        error = caught as Error
    }

    t.true(
        error !== undefined && /"mode"/.test(error.message),
        `Unknown mode option throws a descriptive error: ${error?.message}`
    )
})

function createMemoryCompilerHost(
    files: Map<string, string>,
    compilerOptions: ts.CompilerOptions
): ts.CompilerHost {
    const host                  = ts.createCompilerHost(compilerOptions, true)
    const originalGetSourceFile = host.getSourceFile.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const text = files.get(fileName)

        if (text !== undefined) {
            return ts.createSourceFile(fileName, text, languageVersionOrOptions, true, ts.ScriptKind.TS)
        }

        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    return host
}

function getTransformedSourceFile(
    t: Test,
    compilerHost: ts.CompilerHost,
    compilerOptions: ts.CompilerOptions,
    config: MixinClassTransformerConfig
): ts.SourceFile {
    const mixinHost  = createMixinClassCompilerHost(ts, compilerHost, compilerOptions, config)
    const sourceFile = mixinHost.getSourceFile(sourceFileName, ts.ScriptTarget.ES2022, undefined, false)

    if (sourceFile === undefined) {
        t.fail("Missing transformed source file.")
        throw new Error("Missing transformed source file.")
    }

    return sourceFile
}
