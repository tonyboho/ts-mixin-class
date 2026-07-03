import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import {
    commandOutput, createSourceFile, createTypeScriptFixture, packageRoot,
    runCommand, runFixtureTypecheck, typecheckText
} from "./util.js"

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

// Migrated to NATIVE `ts.Diagnostic`s (the whole invalid-mixin-declaration family shares code
// TS990004); run through the real patched `tsc` so the diagnostic wrap surfaces them.
it("reports unsupported mixin class declarations with native diagnostics", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                @mixin()
                abstract class AbstractMixin {
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

                // A static {} block on a mixin is SUPPORTED (it lands in the factory class
                // expression and runs once per distinct base, like static field initializers) —
                // it must NOT surface in the invalid-declaration family below.
                @mixin()
                class StaticBlockMixin {
                    static {
                    }
                }

                // Parameter properties declare real instance members, so they follow the
                // declared-field rules: public only, explicit type required.
                @mixin()
                class PrivateParamPropertyMixin {
                    constructor(private secret: string = "s") {
                    }
                }

                @mixin()
                class UntypedParamPropertyMixin {
                    constructor(public label = "l") {
                    }
                }
            `
        } ]
    })

    try {
        const output = commandOutput(await runFixtureTypecheck(fixture))

        assertMessageParts(t, output, [
            "TS990004",
            "Invalid mixin class declaration",
            "Mixin class AbstractMixin cannot be abstract",
            "Mixin class PrivateMixin member value cannot be private or protected",
            "Mixin class HashPrivateMixin member #value cannot use ECMAScript private names",
            "Mixin class AbstractMemberMixin member value cannot be abstract",
            "Mixin class MissingPropertyTypeMixin property value must have an explicit type annotation",
            "Mixin class MissingMethodReturnTypeMixin method method must have an explicit return type annotation",
            "Mixin class MissingParameterTypeMixin method parameter value must have an explicit type annotation",
            "Mixin class MissingAccessorTypeMixin accessor value must have an explicit type annotation",
            "Mixin class PrivateParamPropertyMixin parameter property secret cannot be private or protected",
            "Mixin class UntypedParamPropertyMixin parameter property label must have an explicit type annotation"
        ])

        t.notMatch(output, "StaticBlockMixin", "a static initialization block on a mixin is supported")
    } finally {
        await fixture.dispose()
    }
})

// Migrated to a NATIVE `ts.Diagnostic` (code TS990002): run through the real patched `tsc` so the
// diagnostic wrap surfaces it (the in-process `typecheckText` path only sees type-encoded errors).
it("rejects an anonymous default mixin class with a native diagnostic", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                @mixin()
                export default class {
                    value: string = "x"
                }
            `
        } ]
    })

    try {
        const output = commandOutput(await runFixtureTypecheck(fixture))

        assertMessageParts(t, output, [
            "Invalid mixin class declaration",
            "default-exported mixin class must be named",
            "export default class MyMixin",
            "TS990002"
        ])
    } finally {
        await fixture.dispose()
    }
})

// Migrated to a NATIVE `ts.Diagnostic` (code TS990003).
it("rejects an anonymous mixin consumer class with a native diagnostic", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                @mixin()
                class SourceMixin {
                    value: string = "x"
                }

                export default class implements SourceMixin {
                }
            `
        } ]
    })

    try {
        const output = commandOutput(await runFixtureTypecheck(fixture))

        assertMessageParts(t, output, [
            "Invalid mixin consumer declaration",
            "A mixin consumer class must be named",
            "export default class Consumer",
            "TS990003"
        ])
    } finally {
        await fixture.dispose()
    }
})

// Migrated to a NATIVE `ts.Diagnostic` (code TS990005), spanned on the offending base expression
// and surfaced by the real patched `tsc`.
it("reports unsupported mixin consumer base expressions with a native diagnostic", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : `
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
            `
        } ]
    })

    try {
        const output = commandOutput(await runFixtureTypecheck(fixture))

        assertMessageParts(t, output, [
            "TS990005",
            "Unsupported mixin consumer base expression",
            "Consumer extends makeBase()",
            "Only named base classes such as Base or ns.Base are supported for now",
            "assign the expression to a named class or const"
        ])
    } finally {
        await fixture.dispose()
    }
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

// A consumer (or a dependent mixin) declared ABOVE the `@mixin` it applies, in the SAME scope:
// plain TS allows it (`implements` is type-only), but the transform generates a VALUE reference
// to the mixin, so module evaluation would hit the const TDZ. TypeScript's own TS2448 fires on
// the generated line and remaps to a misleading position (the import line), so a NATIVE
// diagnostic (TS990008) names the real fix, with its span on the consumer's heritage reference.
// A use in a DIFFERENT (deferred) scope — a function body referencing a later top-level mixin —
// is legal at runtime and must NOT be flagged.
it("reports a consumer declared before its mixin in the same scope with a native diagnostic", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : [
                'import { mixin } from "ts-mixin-class"',
                "",
                "export class Early implements Tagged {",
                "}",
                "",
                "@mixin()",
                "class DependentEarly implements Tagged {",
                "    own(): string { return super.tag() }",
                "}",
                "",
                "@mixin()",
                "class Tagged {",
                "    tag(): string { return \"t\" }",
                "}",
                "",
                "export function deferred(): string {",
                "    class LaterIsFine implements Late {}",
                "",
                "    return new LaterIsFine().late()",
                "}",
                "",
                "@mixin()",
                "class Late {",
                "    late(): string { return \"l\" }",
                "}",
                ""
            ].join("\n")
        } ]
    })

    try {
        const expectedParts = [
            "TS990008",
            "is declared later in the same scope",
            "Declare the mixin before",
            // The span lands on the consumer's heritage reference (`Tagged` on line 3), and on
            // the dependent mixin's heritage reference (line 7).
            "source.ts(3,31)",
            "source.ts(7,33)"
        ]

        // Source-view plane (`--noEmit`) — TypeScript itself reports NOTHING here (the TDZ is in
        // generated value code the source-view tree does not evaluate), so the native diagnostic
        // is the only signal.
        const sourceViewOutput = commandOutput(await runFixtureTypecheck(fixture))

        assertMessageParts(t, sourceViewOutput, expectedParts)
        t.notMatch(sourceViewOutput, "source.ts(17", "a deferred-scope use of a later mixin is not flagged")
        t.notMatch(sourceViewOutput, "LaterIsFine", "the legal nested consumer is not named in any diagnostic")

        // Emit plane (plain `tsc`) — the same native diagnostic at the same position (TS2448
        // also fires there, on its own remapped position).
        const emitOutput = commandOutput(await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        ))

        assertMessageParts(t, emitOutput, expectedParts)
    } finally {
        await fixture.dispose()
    }
})

// The QUALIFIED twin of the guard above: a consumer using a LOCAL-namespace mixin
// (`implements NS.Tagger`) declared ABOVE the namespace statement. The generated value
// reference (`NS.Tagger` in the runtime chain) evaluates while `var NS` is still
// undefined — a guaranteed runtime TypeError instead of the bare-name const TDZ. The guard
// resolves the dotted reference and compares the namespace STATEMENT's position (the
// declaration's ancestor in the consumer's own statement list), so a consumer BELOW the
// namespace and a DEFERRED-scope use stay legal.
it("reports a consumer declared before its mixin's namespace with a native diagnostic", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ {
            fileName : "source.ts",
            text     : [
                'import { mixin } from "ts-mixin-class"',
                "",
                "export class Early implements NS.Tagger {",
                "}",
                "",
                "export function deferredIsFine(): string {",
                "    class LaterIsFine implements NS.Tagger {}",
                "",
                "    return new LaterIsFine().tag()",
                "}",
                "",
                "namespace NS {",
                "    @mixin()",
                "    export class Tagger {",
                "        tag(): string { return \"t\" }",
                "    }",
                "}",
                "",
                "export class BelowIsFine implements NS.Tagger {",
                "}",
                ""
            ].join("\n")
        } ]
    })

    try {
        const expectedParts = [
            "TS990008",
            "is declared later in the same scope",
            "Declare the mixin before",
            // The span lands on the consumer's qualified heritage reference (`NS.Tagger` on
            // line 3), naming the dotted reference.
            "source.ts(3,31)",
            "NS.Tagger"
        ]

        const sourceViewOutput = commandOutput(await runFixtureTypecheck(fixture))

        assertMessageParts(t, sourceViewOutput, expectedParts)
        t.notMatch(sourceViewOutput, "source.ts(7", "a deferred-scope qualified use of the later namespace is not flagged")
        t.notMatch(sourceViewOutput, "source.ts(19", "a consumer below the namespace is not flagged")

        const emitOutput = commandOutput(await runCommand(
            "node",
            [ path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", fixture.tsconfigFile ],
            fixture.directory
        ))

        assertMessageParts(t, emitOutput, expectedParts)
        t.notMatch(emitOutput, "source.ts(7", "emit plane: the deferred-scope use stays legal")
        t.notMatch(emitOutput, "source.ts(19", "emit plane: the below-the-namespace consumer stays legal")
    } finally {
        await fixture.dispose()
    }
})
