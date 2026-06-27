import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { createTypeScriptFixture, packageRoot, requiredFixtureSourceFile, trimIndent } from "./util.js"
import { assertDiagnosticParts, assertResponseBody, runTypeScriptServerRequest } from "./tsserver-util.js"

type SemanticDiagnostic = {
    code?    : number,
    text?    : string,
    message? : string
}

const requiredBaseDiagnosticParts = [
    "Mixin required base mismatch",
    "Mixin RequiredMixin can only be applied to RequiredBase",
    "BadRequiredConsumer extends UnrelatedRequiredConsumerBase",
    "extends means a required consumer base"
]

const linearizationDiagnosticParts = [
    "Cannot linearize mixin classes with the C3 algorithm",
    "Conflicting order requirements",
    "LinearizationA -> LinearizationB",
    "LinearizationB -> LinearizationA"
]

const invalidMixinDiagnosticParts = [
    "Invalid mixin class declaration",
    "Mixin class ConstructorMixin cannot declare a constructor",
    "Mixin class PrivateMixin member value cannot be private or protected",
    "Mixin class MissingPropertyTypeMixin property value must have an explicit type annotation",
    "Mixin class MissingMethodReturnTypeMixin method method must have an explicit return type annotation",
    "Mixin class MissingParameterTypeMixin method parameter value must have an explicit type annotation",
    "Mixin class MissingAccessorTypeMixin accessor value must have an explicit type annotation"
]

const anonymousConsumerDiagnosticParts = [
    "Invalid mixin consumer declaration",
    "A mixin consumer class must be named",
    "export default class Consumer"
]

const unsupportedBaseDiagnosticParts = [
    "Unsupported mixin consumer base expression",
    "Consumer extends makeBase()",
    "Only named base classes such as Base or ns.Base are supported for now",
    "assign the expression to a named class or const"
]

const missingRuntimeImportDiagnosticParts = [
    "Missing mixin runtime value",
    "Consumer Consumer implements BrokenMixin",
    "broken-mixin-package",
    "could not find a JavaScript runtime module"
]

const staticCollisionDiagnosticParts = [
    "Static mixin member collision",
    "BadStaticCollisionConsumer",
    "StaticCollisionLeftMixin",
    "StaticCollisionRightMixin",
    "shared"
]

const diagnosticMixinsText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    export class RequiredBase {
        requiredMethod(): string {
            return "required"
        }
    }

    @mixin()
    export class RequiredMixin extends RequiredBase {
        mixinMethod(): string {
            return super.requiredMethod()
        }
    }
`)

const importedRequiredBaseDiagnosticText = trimIndent(`
    import { RequiredMixin } from "./mixins.js"

    class UnrelatedRequiredConsumerBase {
    }

    class BadRequiredConsumer extends UnrelatedRequiredConsumerBase implements RequiredMixin {
    }
`)

const diagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    class RequiredBase {
        requiredMethod(): string {
            return "required"
        }
    }

    class UnrelatedRequiredConsumerBase {
    }

    @mixin()
    class RequiredMixin extends RequiredBase {
        mixinMethod(): string {
            return super.requiredMethod()
        }
    }

    class BadRequiredConsumer extends UnrelatedRequiredConsumerBase implements RequiredMixin {
    }

    @mixin()
    class LinearizationA {
    }

    @mixin()
    class LinearizationB {
    }

    @mixin()
    class LinearizationX implements LinearizationA, LinearizationB {
    }

    @mixin()
    class LinearizationY implements LinearizationB, LinearizationA {
    }

    @mixin()
    class BadLinearizationMixin implements LinearizationX, LinearizationY {
    }

    class BadLinearizationConsumer implements BadLinearizationMixin {
    }
`)

const invalidMixinDiagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    abstract class AbstractMixin {
    }

    @mixin()
    class ConstructorMixin {
        constructor() {}
    }

    @mixin()
    class PrivateMixin {
        private value: string = "x"
    }

    @mixin()
    class MissingPropertyTypeMixin {
        value = "x"
    }

    @mixin()
    class MissingMethodReturnTypeMixin {
        method() {
            return "x"
        }
    }

    @mixin()
    class MissingParameterTypeMixin {
        method(value): string {
            return String(value)
        }
    }

    @mixin()
    class MissingAccessorTypeMixin {
        get value() {
            return "x"
        }
    }
`)

const anonymousConsumerDiagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    @mixin()
    class SourceMixin {
        value: string = "x"
    }

    export default class implements SourceMixin {
    }
`)

const unsupportedBaseDiagnosticText = trimIndent(`
    import { mixin } from "ts-mixin-class"

    function makeBase(): new () => object {
        return class {
        }
    }

    @mixin()
    class SourceMixin {
        value: string = "x"
    }

    class Consumer extends makeBase() implements SourceMixin {
    }
`)

const brokenMixinDeclarationText = trimIndent(`
    import type { RuntimeMixinClass } from "ts-mixin-class"

    export interface BrokenMixin {
        brokenMethod(): string
    }

    export declare const BrokenMixin: RuntimeMixinClass & {
        new (...args: any[]): BrokenMixin
    }
`)

const missingRuntimeImportConsumerText = trimIndent(`
    import type { BrokenMixin } from "broken-mixin-package"

    class Consumer implements BrokenMixin {
    }
`)

it("tsserver semantic diagnostics report mixin transform type errors", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : diagnosticText
            }
        ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                diagnosticText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, requiredBaseDiagnosticParts)
        assertDiagnosticParts(t, messages, linearizationDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

const disabledConstructionText = trimIndent(`
    import { Base } from "ts-mixin-class/base"

    class Model extends Base {
        id: string = ""
    }

    export const ok  = Model.new({ id : "x" })
    export const bad = new Model({ id : "x" })
`)

it("tsserver semantic diagnostics disable direct construction with a descriptive message", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: disabledConstructionText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                disabledConstructionText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, [
            "direct `new Model(...)` is disabled",
            "construction runs through the generated static `new` factory"
        ])

        t.notMatch(messages, "Model.new({ id", "the static `new` factory call must not be flagged")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report imported required-base mixin errors", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "source.ts",
                text     : importedRequiredBaseDiagnosticText
            },
            {
                fileName : "mixins.ts",
                text     : diagnosticMixinsText
            }
        ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                importedRequiredBaseDiagnosticText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, requiredBaseDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report invalid mixin declarations with custom messages", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles : [
            {
                fileName : "source.ts",
                text     : invalidMixinDiagnosticText
            }
        ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                invalidMixinDiagnosticText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, invalidMixinDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report anonymous mixin consumers with a custom message", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles : [
            {
                fileName : "source.ts",
                text     : anonymousConsumerDiagnosticText
            }
        ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                anonymousConsumerDiagnosticText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, anonymousConsumerDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report unsupported mixin consumer base expressions with a custom message", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles : [
            {
                fileName : "source.ts",
                text     : unsupportedBaseDiagnosticText
            }
        ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                unsupportedBaseDiagnosticText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, unsupportedBaseDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics report declaration mixins without runtime values", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : [
            {
                fileName : "node_modules/broken-mixin-package/package.json",
                text     : JSON.stringify({
                    name    : "broken-mixin-package",
                    type    : "module",
                    exports : {
                        "." : {
                            types : "./index.d.ts"
                        }
                    }
                }, null, 4)
            }
        ],
        sourceFiles : [
            {
                fileName : "source.ts",
                text     : missingRuntimeImportConsumerText
            },
            {
                fileName : "node_modules/broken-mixin-package/index.d.ts",
                text     : brokenMixinDeclarationText
            }
        ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                missingRuntimeImportConsumerText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, missingRuntimeImportDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

// Regression guard (emit↔source-view parity, §12.7 / §5.4): a manual `.mix(Base)` of a mixin
// that depends on another mixin must type-check in source-view (IDE) exactly as in emit.
// Previously tsserver reported a spurious `TS2339: Property 'mainMethod' does not exist on
// type 'ManualWithDependency'` — the mixin's OWN method was lost from the source-view type of
// `Main.mix(UserBase)` when `Main` has a dependency, because the dependency's framework `mix`
// (returning the dependency's narrower instance) was intersected ahead of the mixin's own
// `mix` and won overload resolution. Fixed by excluding `mix` from the inherited dependency
// statics (`Omit<ClassStatics<typeof Dep>, "mix">` in the source-view value cast).
it("a manual .mix of a dependent mixin is clean in source-view", async (t: Test) => {
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Dep {
            depMethod(): string { return "dep" }
        }

        @mixin()
        class Main implements Dep {
            mainMethod(): string { return "main/" + super.depMethod() }
        }

        class UserBase {
            prefix: string = ""
        }

        class ManualWithDependency extends Main.mix(UserBase) {
            combined(): string {
                return this.mainMethod() + "/" + this.depMethod()
            }
        }

        void new ManualWithDependency()
    `)

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(fixture.directory, sourceFile, text, "semanticDiagnosticsSync", { file: sourceFile })
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        t.equal(messages, "", "manual .mix of a dependent mixin has no IDE semantic diagnostics")
    } finally {
        await fixture.dispose()
    }
})

it("tsserver semantic diagnostics stay clean for fixture-suite runtime tests", async (t: Test) => {
    const fixtureDirectory = path.join(packageRoot, "tests", "fixture-suite")
    const sourceDirectory  = path.join(fixtureDirectory, "src")
    const sourceFiles      = (await readdir(sourceDirectory))
        .filter((fileName) => fileName.endsWith(".t.ts"))
        .filter((fileName) => !fileName.startsWith("construction-fill-missed-initializers"))
        .map((fileName) => path.join(sourceDirectory, fileName))

    for (const sourceFile of sourceFiles) {
        const text        = await readFile(sourceFile, "utf8")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixtureDirectory,
                sourceFile,
                text,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        t.equal(messages, "", `${path.basename(sourceFile)} has no IDE semantic diagnostics`)
        t.expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([])
    }
})

it("tsserver semantic diagnostics report copied fixture type-errors without expect-error suppressions", async (t: Test) => {
    const typeErrorsSource = await readFile(
        path.join(packageRoot, "tests", "fixture-suite", "src", "type-errors.ts"),
        "utf8"
    )
    const typeErrorsText   = removeExpectErrorLines(typeErrorsSource)
    const mixinsText       = await readFile(
        path.join(packageRoot, "tests", "fixture-suite", "src", "mixins.ts"),
        "utf8"
    )
    const fixture          = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : {
            declaration : true
        },
        sourceFiles : [
            {
                fileName : "type-errors.ts",
                text     : typeErrorsText
            },
            {
                fileName : "mixins.ts",
                text     : mixinsText
            }
        ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "type-errors.ts")
        const diagnostics = assertResponseBody<SemanticDiagnostic[]>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                typeErrorsText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )
        const messages    = diagnostics.map((diagnostic) => diagnostic.text ?? diagnostic.message ?? "").join("\n")

        assertDiagnosticParts(t, messages, requiredBaseDiagnosticParts)
        assertDiagnosticParts(t, messages, linearizationDiagnosticParts)
        assertDiagnosticParts(t, messages, staticCollisionDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

it("fixture type-errors keeps expect-error suppressions for expected diagnostics", async (t: Test) => {
    const typeErrorsSource = await readFile(
        path.join(packageRoot, "tests", "fixture-suite", "src", "type-errors.ts"),
        "utf8"
    )
    const expectErrorLines = typeErrorsSource
        .split("\n")
        .filter((line) => line.includes("@ts-expect-error"))
    const expectErrorText  = expectErrorLines.join("\n")

    t.equal(expectErrorLines.length, 5, "Fixture has one suppression per expected diagnostic")
    t.match(expectErrorText, "ContractSourceClass1", "Fixture suppresses the first contract diagnostic")
    t.match(expectErrorText, "ContractSourceClass2", "Fixture suppresses the second contract diagnostic")
    t.match(expectErrorText, "RequiredMixin", "Fixture suppresses the required-base diagnostic")
    t.match(expectErrorText, "LinearizationX", "Fixture suppresses the linearization diagnostic")
    t.match(expectErrorText, "StaticCollisionLeftMixin", "Fixture suppresses the static collision diagnostic")
})

function removeExpectErrorLines(source: string): string {
    return source
        .split("\n")
        .filter((line) => !line.includes("@ts-expect-error"))
        .join("\n")
}
