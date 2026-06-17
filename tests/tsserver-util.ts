import { fork } from "node:child_process"
import path from "node:path"
import type { Test } from "@bryntum/siesta/nodejs.js"

export type TsServerMessage = {
    body? : unknown,
    type? : string,
    command? : string,
    event? : string,
    message? : string,
    request_seq? : number
    success? : boolean
}

export type TsServerResponse = TsServerMessage

export function assertResponseBody<Body>(t: Test, response: TsServerResponse): Body {
    t.true(response.success, response.message ?? `tsserver ${response.command ?? "request"} succeeds`)

    if (response.body === undefined) {
        throw new Error(`Missing tsserver response body: ${JSON.stringify(response)}`)
    }

    return response.body as Body
}

export function assertDiagnosticParts(t: Test, messages: string, expectedParts: string[]): void {
    for (const expectedPart of expectedParts) {
        t.match(messages, expectedPart, `Diagnostics include ${expectedPart}`)
    }
}

// A long-lived tsserver process: open the project once, then fire many requests
// over the same process. The one-shot `runTypeScriptServerRequest` forks a fresh
// server per request (fine for a single assertion), which is far too slow for
// the quickinfo / rename stress tests that issue hundreds of requests — those
// open a session once and reuse it.
export type TsServerSession = {
    request(command: string, args: unknown): Promise<TsServerResponse>,
    open(file: string, fileContent: string): Promise<void>,
    close(): Promise<void>
}

export function openTsServerSession(
    fixtureDirectory: string,
    logFile = path.join(fixtureDirectory, "tsserver.log")
): TsServerSession {
    const tsserverFile = path.join(fixtureDirectory, "node_modules", "typescript", "lib", "tsserver.js")
    const server = fork(tsserverFile, [
        "--logVerbosity",
        "verbose",
        "--logFile",
        logFile,
        "--allowLocalPluginLoads",
        "--useNodeIpc"
    ], {
        cwd    : fixtureDirectory,
        silent : true
    })

    const pendingResponses = new Map<number, (response: TsServerResponse) => void>()
    let sequence           = 0

    server.on("message", (message: TsServerResponse) => {
        if (message.type !== "response" || message.request_seq === undefined) {
            return
        }

        pendingResponses.get(message.request_seq)?.(message)
        pendingResponses.delete(message.request_seq)
    })

    server.stdout?.on("data", () => {})

    const request = async (command: string, args: unknown): Promise<TsServerResponse> => {
        const seq = ++sequence

        server.send({
            arguments : args,
            command,
            seq,
            type      : "request"
        })

        return new Promise<TsServerResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingResponses.delete(seq)
                reject(new Error(`Timed out waiting for tsserver response to ${command}.`))
            }, 10_000)

            pendingResponses.set(seq, (response) => {
                clearTimeout(timeout)
                resolve(response)
            })
        })
    }

    return {
        request,

        async open(file: string, fileContent: string): Promise<void> {
            await request("open", {
                file,
                fileContent,
                projectRootPath : fixtureDirectory,
                scriptKindName  : "TS"
            })
        },

        async close(): Promise<void> {
            server.send({
                arguments : {},
                command   : "exit",
                seq       : ++sequence,
                type      : "request"
            })

            await waitForExit(server)
        }
    }
}

export async function runTypeScriptServerRequest(
    fixtureDirectory: string,
    sourceFile: string,
    text: string,
    command: string,
    args: unknown,
    logFile = path.join(fixtureDirectory, "tsserver.log")
): Promise<TsServerResponse> {
    const session = openTsServerSession(fixtureDirectory, logFile)

    await session.open(sourceFile, text)
    const response = await session.request(command, args)

    await session.close()

    return response
}

export function positionToLineOffset(text: string, position: number): { line: number, offset: number } {
    const before = text.slice(0, position)
    const lines  = before.split("\n")

    return {
        line   : lines.length,
        offset : lines.at(-1)!.length + 1
    }
}

async function waitForExit(server: ReturnType<typeof fork>): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            server.kill()
            reject(new Error("Timed out waiting for tsserver to exit."))
        }, 10_000)

        server.once("exit", () => {
            clearTimeout(timeout)
            resolve()
        })
        server.once("error", (error) => {
            clearTimeout(timeout)
            reject(error)
        })
    })
}
