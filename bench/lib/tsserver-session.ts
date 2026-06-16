import { fork } from "node:child_process"
import path from "node:path"

// Minimal tsserver driver shared by the diagnostics and edit scenarios: fork a
// real tsserver over Node IPC, send requests, await responses, exit cleanly.

export type TsServerResponse = {
    body?       : unknown,
    command?    : string,
    message?    : string,
    request_seq?: number,
    success?    : boolean,
    type?       : string
}

export type TsServerSession = {
    close       : () => Promise<void>,
    sendRequest : (command: string, args: unknown) => Promise<TsServerResponse>
}

export function createTsServerSession(tsserverFile: string, fixtureDirectory: string): TsServerSession {
    const server = fork(tsserverFile, [
        "--logVerbosity",
        "terse",
        "--logFile",
        path.join(fixtureDirectory, "tsserver.log"),
        "--allowLocalPluginLoads",
        "--useNodeIpc"
    ], {
        cwd    : fixtureDirectory,
        silent : true
    })
    const pendingResponses = new Map<number, (response: TsServerResponse) => void>()
    let sequence = 0

    server.on("message", (message: TsServerResponse) => {
        if (message.type !== "response" || message.request_seq === undefined) {
            return
        }

        pendingResponses.get(message.request_seq)?.(message)
        pendingResponses.delete(message.request_seq)
    })
    server.stdout?.on("data", () => {})
    server.stderr?.on("data", () => {})

    return {
        close       : stopServer,
        sendRequest
    }

    function sendRequest(command: string, args: unknown): Promise<TsServerResponse> {
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
            }, 30_000)

            pendingResponses.set(seq, (response) => {
                clearTimeout(timeout)
                resolve(response)
            })
        })
    }

    async function stopServer(): Promise<void> {
        if (!server.connected) {
            return
        }

        server.send({
            arguments : {},
            command   : "exit",
            seq       : ++sequence,
            type      : "request"
        })

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
}

export async function openFile(session: TsServerSession, fileName: string, text: string): Promise<void> {
    assertSuccessfulTsServerResponse(
        await session.sendRequest("open", {
            file            : fileName,
            fileContent     : text,
            projectRootPath : path.dirname(path.dirname(fileName)),
            scriptKindName  : "TS"
        }),
        "open"
    )
}

export function assertSuccessfulTsServerResponse(response: TsServerResponse, command: string): void {
    if (response.success !== true) {
        throw new Error(response.message ?? `tsserver ${command} failed`)
    }
}
