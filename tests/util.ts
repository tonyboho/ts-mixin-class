import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import ts from "typescript"
import type { Test } from "@bryntum/siesta/nodejs.js"

// dist/tests/util.js -> корень пакета
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const execFileAsync = promisify(execFile)

export type CommandResult = {
    command  : string,
    exitCode : number,
    stdout   : string,
    stderr   : string
}

type ExecFileFailure = Error & {
    code?   : number | string,
    stdout? : string | Buffer,
    stderr? : string | Buffer
}

export type TypeScriptFixtureOptions = {
    sourceFiles            : TypeScriptFixtureSourceFile[],
    extraFiles?            : TypeScriptFixtureSourceFile[],
    experimentalDecorators : boolean,
    compilerOptions?       : Record<string, unknown>,
    compilerPlugins?       : Record<string, unknown>[],
    keep?                  : boolean
}

export type TypeScriptFixtureSourceFile = {
    fileName : string,
    text     : string
}

export type TypeScriptFixture = {
    directory    : string,
    sourceFiles  : Map<string, string>,
    tsconfigFile : string,
    dispose      : () => Promise<void>
}

export function requiredFixtureSourceFile(sourceFiles: Map<string, string>, fileName: string): string {
    const sourceFile = sourceFiles.get(fileName)

    if (sourceFile === undefined) {
        throw new Error(`Missing fixture source file: ${fileName}`)
    }

    return sourceFile
}

export async function createTypeScriptFixture(options: TypeScriptFixtureOptions): Promise<TypeScriptFixture> {
    const directory       = await mkdtemp(path.join(tmpdir(), "ts-mixin-class-"))
    const packageJsonFile = path.join(directory, "package.json")
    const tsconfigFile    = path.join(directory, "tsconfig.json")
    const sourceFilePaths = new Map(options.sourceFiles.map(({ fileName }) => [ fileName, path.join(directory, fileName) ]))

    await writeJson(packageJsonFile, createPackageJson())
    await writeJson(tsconfigFile, createTsconfig(
        options.sourceFiles.map(({ fileName }) => fileName),
        options.experimentalDecorators,
        options.compilerOptions,
        options.compilerPlugins
    ))

    for (const { fileName, text } of [ ...options.sourceFiles, ...(options.extraFiles ?? []) ]) {
        const sourceFilePath = path.join(directory, fileName)

        await mkdir(path.dirname(sourceFilePath), { recursive: true })
        await writeFile(sourceFilePath, text)
    }

    await linkNodeModules(directory)

    return {
        directory,
        sourceFiles : sourceFilePaths,
        tsconfigFile,

        async dispose() {
            if (options.keep) {
                return
            }

            await rm(directory, { force: true, recursive: true })
        }
    }
}

function createPackageJson(): unknown {
    return {
        name    : "ts-mixin-class-tsserver-fixture",
        private : true,
        type    : "module"
    }
}

function createTsconfig(
    sourceFileNames: string[],
    experimentalDecorators: boolean,
    compilerOptions: Record<string, unknown> | undefined,
    compilerPlugins: Record<string, unknown>[] | undefined
): unknown {
    const {
        plugins : compilerOptionPlugins,
        ...restCompilerOptions
    } = compilerOptions ?? {}
    const extraCompilerOptionPlugins = Array.isArray(compilerOptionPlugins) ? compilerOptionPlugins : []

    return {
        compilerOptions : {
            target                  : "ES2022",
            module                  : "ESNext",
            moduleResolution        : "Bundler",
            lib                     : [ "ES2022", "DOM" ],
            useDefineForClassFields : false,
            skipLibCheck            : true,
            outDir                  : "dist",
            plugins                 : [
                {
                    transform        : "ts-mixin-class",
                    transformProgram : true
                },
                // The editor-only companion plugin: the transform appends each generated
                // `<Name>Config` alias as real text past the document end so its name renders
                // natively; this plugin filters / remaps the resulting phantom navigation.
                {
                    name : "ts-mixin-class/language-service-plugin"
                },
                ...(compilerPlugins ?? []),
                ...extraCompilerOptionPlugins
            ],
            ...restCompilerOptions,
            strict : true,
            experimentalDecorators
        },
        files : sourceFileNames
    }
}

async function linkNodeModules(directory: string): Promise<void> {
    const nodeModules  = path.join(directory, "node_modules")
    const bryntumScope = path.join(nodeModules, "@bryntum")

    await mkdir(nodeModules, { recursive: true })
    await mkdir(bryntumScope, { recursive: true })
    await symlink(packageRoot, path.join(nodeModules, "ts-mixin-class"), "dir")
    await symlink(path.join(packageRoot, "node_modules/typescript"), path.join(nodeModules, "typescript"), "dir")
    await symlink(path.join(packageRoot, "node_modules/@bryntum/siesta"), path.join(bryntumScope, "siesta"), "dir")
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
    await writeFile(fileName, `${JSON.stringify(value, null, 4)}\n`)
}

export async function runPnpm(
    cwd: string,
    ...args: string[]
): Promise<CommandResult> {
    return runCommand("pnpm", args, cwd)
}

export async function runCommand(
    executable: string,
    args: string[],
    cwd: string
): Promise<CommandResult> {
    const command = [ executable, ...args ].join(" ")

    try {
        const result = await execFileAsync(executable, args, { cwd })

        return {
            command,
            exitCode : 0,
            stdout   : outputToString(result.stdout),
            stderr   : outputToString(result.stderr)
        }
    } catch (error) {
        const failure = error as ExecFileFailure

        return {
            command,
            exitCode : typeof failure.code === "number" ? failure.code : 1,
            stdout   : outputToString(failure.stdout),
            stderr   : outputToString(failure.stderr || failure.message)
        }
    }
}

export function assertSuccessfulCommand(
    t: Test,
    result: CommandResult,
    description: string
): void {
    if (result.exitCode === 0) {
        t.pass(description)
        return
    }

    t.fail(`${description} failed with exit code ${result.exitCode}\n${commandOutput(result)}`)
}

export function commandOutput(result: CommandResult): string {
    return [
        "command:",
        result.command,
        "",
        "stdout:",
        result.stdout || "<empty>",
        "",
        "stderr:",
        result.stderr || "<empty>"
    ].join("\n")
}

// Type-check a fixture with the package's own patched `tsc` (the program transform + its
// `getSemanticDiagnostics` wrap run, so NATIVE transformer diagnostics surface — unlike the
// in-process `transformSourceFile -> printSourceFile -> typecheckText` path, which only sees
// type-encoded errors baked into the reprinted text). `--noEmit` keeps it a pure check.
export async function runFixtureTypecheck(fixture: TypeScriptFixture): Promise<CommandResult> {
    return runCommand(
        "node",
        [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile, "--noEmit" ],
        fixture.directory
    )
}

export function createSourceFile(text: string): ts.SourceFile
export function createSourceFile(fileName: string, text: string): ts.SourceFile
export function createSourceFile(fileNameOrText: string, maybeText?: string): ts.SourceFile {
    const fileName = maybeText === undefined ? "source.ts" : fileNameOrText
    const text     = maybeText === undefined ? fileNameOrText : maybeText

    return ts.createSourceFile(
        fileName,
        trimIndent(text),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    )
}

export function trimIndent(text: string): string {
    const lines     = text.replace(/^\n/, "").replace(/\n\s*$/, "").split("\n")
    const minIndent = Math.min(
        ...lines
            .filter((line) => line.trim() !== "")
            .map((line) => line.match(/^\s*/)?.[0].length ?? 0)
    )

    return lines.map((line) => line.slice(minIndent)).join("\n")
}

export function findFirst<Node extends ts.Node>(
    root: ts.Node,
    predicate: (node: ts.Node) => node is Node
): Node | undefined {
    let found: Node | undefined

    const visit = (node: ts.Node): void => {
        if (found !== undefined) {
            return
        }

        if (predicate(node)) {
            found = node
            return
        }

        ts.forEachChild(node, visit)
    }

    visit(root)

    return found
}

export function findClass(sourceFile: ts.SourceFile, name: string): ts.ClassDeclaration | undefined {
    return findFirst(sourceFile, (node): node is ts.ClassDeclaration => {
        return ts.isClassDeclaration(node) && node.name?.text === name
    })
}

export function findInterface(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration | undefined {
    return findFirst(sourceFile, (node): node is ts.InterfaceDeclaration => {
        return ts.isInterfaceDeclaration(node) && node.name.text === name
    })
}

export function findVariable(sourceFile: ts.SourceFile, name: string): ts.VariableDeclaration | undefined {
    return findFirst(sourceFile, (node): node is ts.VariableDeclaration => {
        return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name
    })
}

// Полноценный тайпчек текста как модуля, импортирующего "ts-mixin-class":
// пакет резолвится в локальный src/index.ts, остальное — обычный node resolution
export function typecheckText(text: string): string[] {
    const virtualFileName = path.join(packageRoot, "typecheck-virtual-test.ts")

    const options: ts.CompilerOptions = {
        strict                  : true,
        target                  : ts.ScriptTarget.ES2022,
        module                  : ts.ModuleKind.NodeNext,
        moduleResolution        : ts.ModuleResolutionKind.NodeNext,
        useDefineForClassFields : false,
        noEmit                  : true,
        skipLibCheck            : true,
        types                   : [ "node" ]
    }

    const host = ts.createCompilerHost(options)

    const originalGetSourceFile = host.getSourceFile.bind(host)
    const originalFileExists    = host.fileExists.bind(host)

    host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        if (path.resolve(fileName) === virtualFileName) {
            return ts.createSourceFile(virtualFileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
        }

        return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    }

    host.fileExists = (fileName) => {
        return path.resolve(fileName) === virtualFileName || originalFileExists(fileName)
    }

    host.resolveModuleNameLiterals = (moduleLiterals, containingFile, _redirectedReference, compilerOptions) => {
        return moduleLiterals.map((literal) => {
            if (literal.text === "ts-mixin-class") {
                return {
                    resolvedModule : {
                        resolvedFileName        : path.join(packageRoot, "src", "index.ts"),
                        extension               : ts.Extension.Ts,
                        isExternalLibraryImport : false
                    }
                }
            }

            return ts.resolveModuleName(literal.text, containingFile, compilerOptions, host)
        })
    }

    const program = ts.createProgram([ virtualFileName ], options, host)

    return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
        const message  = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
        const location = diagnostic.file !== undefined && diagnostic.start !== undefined
            ? `(${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1})`
            : ""

        return `TS${diagnostic.code}${location}: ${message}`
    })
}

function outputToString(output: string | Buffer | undefined): string {
    return output?.toString() ?? ""
}
