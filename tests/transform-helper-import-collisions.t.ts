import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

// The injected helper-TYPE imports must ride reserved `__X__` aliases (exactly like the
// VALUE helpers' `__defineMixinClass__`), so the public helper names stay free for the
// user: a same-named local declaration — or the user's own import of the helper from the
// package — must coexist with whatever the transform injects.

it("generated helper-type imports do not collide with same-named user declarations", async (t: Test) => {
    const program = `
        import { mixin } from "ts-mixin-class"

        type AnyConstructor    = new (...args: unknown[]) => object
        type ClassStatics      = { marker: "user" }
        type MixinFactory      = (value: string) => number
        type RuntimeMixinClass = { runtime: true }
        type MixinClassValue   = "user"
        type MixinApplication  = [ string ]

        class GenericBase<T> {
            content: T

            constructor (content: T) {
                this.content = content
            }
        }

        @mixin()
        export class Logger {
            log (ctor: AnyConstructor, statics: ClassStatics, factory: MixinFactory): void {
                void ctor
                void statics
                void factory
            }
        }

        export class App<T> extends GenericBase<T> implements Logger {
            use (runtime: RuntimeMixinClass, value: MixinClassValue, application: MixinApplication): void {
                void runtime
                void value
                void application
            }
        }
        export interface App<T> extends Logger {}
    `

    for (const sourceView of [ false, true ]) {
        const plane       = sourceView ? "source view" : "emit"
        const diagnostics = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program), { sourceView })))

        t.is(diagnostics.length, 0, `${plane}: user-declared helper-named types coexist with the generated import\n${diagnostics.join("\n")}`)
    }
})

it("generated helper-type imports do not collide with the user's own import of the same helper", async (t: Test) => {
    const program = `
        import { mixin, type AnyConstructor } from "ts-mixin-class"

        const holder: { ctor: AnyConstructor | undefined } = { ctor: undefined }
        void holder

        @mixin()
        export class Tagged {
            tag: string = ""
        }

        export class Item implements Tagged {}
        export interface Item extends Tagged {}
    `

    for (const sourceView of [ false, true ]) {
        const plane       = sourceView ? "source view" : "emit"
        const diagnostics = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program), { sourceView })))

        t.is(diagnostics.length, 0, `${plane}: the user's own helper import coexists with the generated one\n${diagnostics.join("\n")}`)
    }
})

it("checker messages render the helper types by their public names, not the import aliases", async (t: Test) => {
    // The alias is only the local BINDING; `typeToString` prints the type's own symbol
    // name, so messages stay readable (`... & RuntimeMixinClass' is not assignable ...`),
    // with no `__RuntimeMixinClass__` artifacts.
    const program = `
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class Logger {
            log (): string { return "x" }
        }

        export class App implements Logger {}
        export interface App extends Logger {}

        const wrong: number = Logger
        void wrong
    `

    const diagnostics = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program)))).join("\n")

    t.match(diagnostics, "RuntimeMixinClass", "The mixin value type renders into the mismatch message")
    t.notMatch(diagnostics, "__RuntimeMixinClass__", "...by its public name, not the reserved import alias")
    t.notMatch(diagnostics, "__AnyConstructor__", "No helper alias leaks into the message")
})
