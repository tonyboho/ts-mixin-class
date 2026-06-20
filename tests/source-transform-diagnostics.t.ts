import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

it("transformed required-base mixin rejects unrelated consumer bases at typecheck time", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class RequiredBase {
            requiredMethod (): string { return "required" }
        }

        class UnrelatedBase {
        }

        @mixin()
        class RequiredMixin extends RequiredBase {
            mixinMethod (): string {
                return super.requiredMethod()
            }
        }

        class Consumer extends UnrelatedBase implements RequiredMixin {
        }
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages    = diagnostics.join("\n")

    assertMessageParts(t, messages, [
        "Mixin required base mismatch",
        "RequiredMixin",
        "RequiredBase"
    ])
})

it("reports unsupported mixin class declarations", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        abstract class AbstractMixin {
        }

        @mixin()
        class ConstructorMixin {
            constructor () {}
        }

        @mixin()
        class PrivateMixin {
            private value: string = "x"
        }

        @mixin()
        class HashPrivateMixin {
            #value: string = "x"
        }

        @mixin()
        class AbstractMemberMixin {
            abstract value: string
        }

        @mixin()
        class MissingPropertyTypeMixin {
            value = "x"
        }

        @mixin()
        class MissingMethodReturnTypeMixin {
            method () {
                return "x"
            }
        }

        @mixin()
        class MissingParameterTypeMixin {
            method (value): string {
                return String(value)
            }
        }

        @mixin()
        class MissingAccessorTypeMixin {
            get value () {
                return "x"
            }
        }
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))
    const messages    = diagnostics.join("\n")

    assertMessageParts(t, messages, [
        "Invalid mixin class declaration",
        "Mixin class AbstractMixin cannot be abstract",
        "Mixin class ConstructorMixin cannot declare a constructor",
        "Mixin class PrivateMixin member value cannot be private or protected",
        "Mixin class HashPrivateMixin member #value cannot use ECMAScript private names",
        "Mixin class AbstractMemberMixin member value cannot be abstract",
        "Mixin class MissingPropertyTypeMixin property value must have an explicit type annotation",
        "Mixin class MissingMethodReturnTypeMixin method method must have an explicit return type annotation",
        "Mixin class MissingParameterTypeMixin method parameter value must have an explicit type annotation",
        "Mixin class MissingAccessorTypeMixin accessor value must have an explicit type annotation"
    ])
})

it("reports anonymous default mixin classes with a custom diagnostic", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export default class {
            value: string = "x"
        }
    `))
    const diagnostics     = typecheckText(printSourceFile(ts, transformedFile))
    const messages        = diagnostics.join("\n")

    assertMessageParts(t, messages, [
        "Invalid mixin class declaration",
        "default-exported mixin class must be named",
        "export default class MyMixin"
    ])
})

it("reports anonymous mixin consumer class declarations with a custom diagnostic", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceMixin {
            value: string = "x"
        }

        export default class implements SourceMixin {
        }
    `))
    const diagnostics     = typecheckText(printSourceFile(ts, transformedFile))
    const messages        = diagnostics.join("\n")

    assertMessageParts(t, messages, [
        "Invalid mixin consumer declaration",
        "A mixin consumer class must be named",
        "export default class Consumer"
    ])
})

it("reports unsupported mixin consumer base expressions with a custom diagnostic", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        function makeBase (): new () => object {
            return class {
            }
        }

        @mixin()
        class SourceMixin {
            value: string = "x"
        }

        class Consumer extends makeBase() implements SourceMixin {
        }
    `))
    const diagnostics     = typecheckText(printSourceFile(ts, transformedFile))
    const messages        = diagnostics.join("\n")

    assertMessageParts(t, messages, [
        "Unsupported mixin consumer base expression",
        "Consumer extends makeBase()",
        "Only named base classes such as Base or ns.Base are supported for now",
        "assign the expression to a named class or const"
    ])
})

it("reports conflicting static members between consumed mixins", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class LeftStaticMixin {
            static shared: string = "left"
        }

        @mixin()
        class RightStaticMixin {
            static shared: number = 1
        }

        class Consumer implements LeftStaticMixin, RightStaticMixin {
        }
    `))
    const diagnostics     = typecheckText(printSourceFile(ts, transformedFile))
    const messages        = diagnostics.join("\n")

    assertMessageParts(t, messages, [
        "Static mixin member collision",
        "Consumer",
        "LeftStaticMixin",
        "RightStaticMixin",
        "shared"
    ])
})

it("reports conflicting static members between consumer base and mixins", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class Base {
            static shared: string = "base"
        }

        @mixin()
        class StaticMixin {
            static shared: number = 1
        }

        class Consumer extends Base implements StaticMixin {
        }
    `))
    const diagnostics     = typecheckText(printSourceFile(ts, transformedFile))
    const messages        = diagnostics.join("\n")

    assertMessageParts(t, messages, [
        "Static mixin member collision",
        "Consumer",
        "Base",
        "StaticMixin",
        "shared"
    ])
})

it("reports method-shaped static collisions only in strict mode", async (t: Test) => {
    const sourceFile         = createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class LeftStaticMixin {
            static shared (): string {
                return "left"
            }
        }

        @mixin()
        class RightStaticMixin {
            static shared (): number {
                return 1
            }
        }

        class Consumer implements LeftStaticMixin, RightStaticMixin {
        }
    `)
    const defaultDiagnostics = typecheckText(printSourceFile(ts, transformSourceFile(ts, sourceFile)))
    const strictDiagnostics  = typecheckText(printSourceFile(ts, transformSourceFile(ts, sourceFile, {
        staticCollisionCheck : "strict"
    })))
    const defaultMessages    = defaultDiagnostics.join("\n")
    const strictMessages     = strictDiagnostics.join("\n")

    t.notMatch(defaultMessages, "Static mixin member collision", "Default mode does not report method-shaped collisions")
    assertMessageParts(t, strictMessages, [
        "Static mixin member collision",
        "shared"
    ])
})

it("can disable static collision diagnostics", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class LeftStaticMixin {
            static shared: string = "left"
        }

        @mixin()
        class RightStaticMixin {
            static shared: number = 1
        }

        class Consumer implements LeftStaticMixin, RightStaticMixin {
        }

        void Consumer
    `), {
        staticCollisionCheck : false
    })
    const diagnostics     = typecheckText(printSourceFile(ts, transformedFile))
    const messages        = diagnostics.join("\n")

    t.notMatch(messages, "Static mixin member collision", "Disabled static collision check does not report collisions")
})

function assertMessageParts(t: Test, messages: string, expectedParts: string[]): void {
    for (const expectedPart of expectedParts) {
        t.match(messages, expectedPart, `Diagnostics include ${expectedPart}`)
    }
}
