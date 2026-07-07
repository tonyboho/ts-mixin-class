import { spawn } from "node:child_process"
import path from "node:path"

import { packageRoot } from "./util.js"

// Shared driver for the real `tsc --watch` end-to-end tests (`tsc-watch.t.ts`,
// `stress-tsc-watch.t.ts`). It spawns the package's own patched TypeScript (the `tsc` reached
// through the symlinked `node_modules/typescript` that `createTypeScriptFixture` sets up, already
// `ts-patch install`ed) in watch mode and lets a test step through one build cycle at a time.

// The package's patched `tsc`, launched with `-w`.
export const tscBin = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

// tsc prints this after every watch build cycle; it is the per-build boundary we synchronize on.
const buildBoundary = "Watching for file changes."

export type TscWatch = {
    // Resolve with the text emitted for the next completed build cycle (everything up to and
    // including the next `Watching for file changes.` marker).
    waitForBuild : (timeoutMs?: number) => Promise<string>,
    dispose      : () => void
}

export function startTscWatch(
    directory: string,
    tsconfigFile: string,
    options: { emit?: boolean } = {}
): TscWatch {
    // `--preserveWatchOutput` stops tsc from clearing the screen (no ANSI cursor codes between
    // builds); `--pretty false` drops color codes so the output is plain, greppable text;
    // `--noEmit` keeps it a pure type-check watch — faster, and nothing is written into the
    // watched directory to risk retriggering the watcher. A test that asserts EMITTED
    // artifacts (e.g. source maps across rebuilds) opts into emit; the output lands in
    // `outDir`, which the watcher does not watch.
    const child = spawn(
        "node",
        [
            tscBin, "-w", "-p", tsconfigFile, "--preserveWatchOutput", "--pretty", "false",
            ...(options.emit === true ? [] : [ "--noEmit" ])
        ],
        { cwd: directory }
    )

    const completedBuilds: string[]            = []
    const waiters: ((build: string) => void)[] = []
    let   pending                              = ""

    const consume = (chunk: string): void => {
        pending += chunk

        let boundary = pending.indexOf(buildBoundary)

        while (boundary !== -1) {
            const end   = boundary + buildBoundary.length
            const build = pending.slice(0, end)

            pending  = pending.slice(end)
            boundary = pending.indexOf(buildBoundary)

            const waiter = waiters.shift()

            if (waiter !== undefined) {
                waiter(build)
            } else {
                completedBuilds.push(build)
            }
        }
    }

    child.stdout.on("data", (chunk: Buffer) => consume(chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => consume(chunk.toString()))

    return {
        waitForBuild(timeoutMs = 30000): Promise<string> {
            const queued = completedBuilds.shift()

            if (queued !== undefined) {
                return Promise.resolve(queued)
            }

            return new Promise<string>((resolve, reject) => {
                const waiter = (build: string): void => {
                    clearTimeout(timer)
                    resolve(build)
                }
                const timer  = setTimeout(
                    () => {
                        const index = waiters.indexOf(waiter)

                        if (index !== -1) {
                            waiters.splice(index, 1)
                        }

                        reject(new Error(`Timed out after ${timeoutMs}ms waiting for a tsc watch build.\nBuffered output:\n${pending}`))
                    },
                    timeoutMs
                )

                waiters.push(waiter)
            })
        },

        dispose(): void {
            child.kill()
        }
    }
}

export function errorCount(build: string): number {
    return Number(build.match(/Found (\d+) error/)?.[1] ?? "0")
}
