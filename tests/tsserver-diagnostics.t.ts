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

// The native (transformer-authored) `@mixin extends @mixin` diagnostic must surface in the IDE
// exactly as it does under `tsc` (see mixin-extends-mixin-diagnostic.t.ts for the emit/CLI plane).
// Both classes live in one file, so this also covers the SAME-FILE branch of the detection (the
// CLI test covers the imported branch). The native `code` (990001) rides through tsserver too.
it("tsserver semantic diagnostics report a `@mixin` extending another mixin with a native diagnostic", async (t: Test) => {
    const text = trimIndent(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Alpha {
            alphaValue(): number {
                return 1
            }
        }

        @mixin()
        class Bravo extends Alpha {
            bravoValue(): number {
                return 2
            }
        }
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
        const nativeCode  = diagnostics.map((diagnostic) => diagnostic.code).find((code) => code === 990001)

        assertDiagnosticParts(t, messages, [
            "cannot extend another mixin",
            "Bravo",
            "Alpha",
            "implements"
        ])
        t.is(nativeCode, 990001, "IDE diagnostic carries the native mixin-diagnostic code 990001")
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

// A manual `.mix(Base)` of a PROGRAM-LOCAL mixin is banned (TS990012) — this pins the IDE
// side of the ban: the native diagnostic rides through tsserver with its code, anchored on
// the user's `.mix` access. (Historically this scenario was made to type-check cleanly in
// source view through a synthetic `.mix` apply type; that node could not support navigation —
// collapsed instance members, a find-all-references crash — and was deleted with the ban.
// The supported manual `.mix` lives on the other side of the package boundary — see the
// declaration-fixture-suite `package-manual-mix*` tests.)
it("a manual .mix of a program-local dependent mixin reports the native TS990012 ban in the IDE", async (t: Test) => {
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
        const nativeCode  = diagnostics.map((diagnostic) => diagnostic.code).find((code) => code === 990012)

        assertDiagnosticParts(t, messages, [
            "Manual mixin application inside a transformer program",
            "Main.mix(...) is reserved for external (non-transformer) consumers",
            "implements Main"
        ])
        t.is(nativeCode, 990012, "IDE diagnostic carries the native mixin-diagnostic code 990012")
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

        // The linearization conflict (BadLinearizationConsumer) is no longer in this corpus: it
        // migrated to a NATIVE diagnostic (TS990007) that `@ts-expect-error` cannot suppress, so it
        // cannot live in a build-must-pass file. Its tsserver coverage is the dedicated
        // linearization-conflict test above; this corpus keeps the still-type-encoded families.
        assertDiagnosticParts(t, messages, requiredBaseDiagnosticParts)
        assertDiagnosticParts(t, messages, staticCollisionDiagnosticParts)
    } finally {
        await fixture.dispose()
    }
})

function removeExpectErrorLines(source: string): string {
    return source
        .split("\n")
        .filter((line) => !line.includes("@ts-expect-error"))
        .join("\n")
}

// --- Construction / config-alias diagnostics (moved from tsserver-construction-config-alias:
// --- these are pure `semanticDiagnosticsSync` message assertions — this file's plane).

// A consumer applying several mixins that each override `initialize` with their own
// strict config. In the editor (source view) the generated `$base` interface re-declares
// the `Base.initialize` protocol member to suppress the TS2320 merge conflict.
const initializeOverrideText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class A extends Base {
        public a!: string = ""

        override initialize(config?: AConfig): void {
            super.initialize(config)
        }
    }

    @mixin()
    class B extends Base {
        public b!: number = 0

        override initialize(config?: BConfig): void {
            super.initialize(config)
        }
    }

    class C extends Base implements A, B {
        public c!: boolean = false
    }

    const created = C.new({ a : "x", b : 1, c : true })
    void created
`)

it("tsserver reports no TS2320 in the editor for a consumer of mixins overriding initialize", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: initializeOverrideText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                initializeOverrideText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        t.notOk(
            diagnostics.some((diagnostic) => diagnostic.code === 2320),
            "The construction consumer's generated base interface does not raise a TS2320 initialize merge conflict"
        )
    } finally {
        await fixture.dispose()
    }
})

// A construction mixin that applies several initialize-overriding mixins WITHOUT its own
// override. Its generated `__Combined$base` interface extends Base + the mixins and gets
// the protocol member injected; in the editor that must suppress TS2320 and the synthetic
// member must not crash navigation.
const mixinMergeText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class A extends Base {
        public a!: string = ""
        override initialize(config: AConfig): void { super.initialize(config) }
    }

    @mixin()
    class B extends Base {
        public b!: number = 0
        override initialize(config: BConfig): void { super.initialize(config) }
    }

    @mixin()
    class Combined extends Base implements A, B {
        public x!: boolean = false
    }

    class Holder extends Base implements Combined {
        public h!: string = ""
    }

    const created = Holder.new({ a : "x", b : 1, x : true, h : "h" })

    // The merged config requires every contributed field; the @ts-expect-error directives
    // double as assertions in the editor too - an unused one surfaces as TS2578.

    // @ts-expect-error - 'a' (from mixin A) is required in the merged config
    const missingA = Holder.new({ b : 1, x : true, h : "h" })
    // @ts-expect-error - 'b' (from mixin B) is required in the merged config
    const missingB = Holder.new({ a : "x", x : true, h : "h" })
    // @ts-expect-error - 'x' (from mixin Combined) is required in the merged config
    const missingX = Holder.new({ a : "x", b : 1, h : "h" })
    // @ts-expect-error - 'h' (Holder's own field) is required in the merged config
    const missingH = Holder.new({ a : "x", b : 1, x : true })

    void [ created, missingA, missingB, missingX, missingH ]
`)

it("tsserver reports no merge/config errors in the editor for a construction mixin merging initialize-overriding mixins", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: mixinMergeText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                mixinMergeText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        // No TS2320 (the merge is fixed) and no TS2578 (every @ts-expect-error is used, i.e.
        // the merged config really does require each contributed field).
        t.equal(
            diagnostics.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`).join("\n"),
            "",
            "A construction mixin merging initialize-overriding mixins is clean in the editor; the merged config requires every contributed field"
        )
    } finally {
        await fixture.dispose()
    }
})

// A three-level chain where every level overrides `initialize` with its own config and the
// middle one is a construction mixin (`extends Base implements Mixin1`). Its `__Mixin2$base`
// interface extends Base + Mixin1 but - unlike the emit structural interface - never carries
// the class's own `initialize`, so it needs the protocol member injected even though Mixin2
// declares `initialize`. This is editor-only: emit is clean even without the fix, so only a
// source-view diagnostics check guards it.
const chainText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Mixin1 extends Base {
        public one!: string = ""
        override initialize(config: Mixin1Config): void { super.initialize(config) }
    }

    @mixin()
    class Mixin2 extends Base implements Mixin1 {
        public two!: number = 0
        override initialize(config: Mixin2Config): void { super.initialize(config) }
    }

    class Consumer extends Base implements Mixin2 {
        public three!: boolean = false
        override initialize(config: ConsumerConfig): void { super.initialize(config) }
    }

    const created = Consumer.new({ one : "x", two : 1, three : true })

    // The merged config requires every contributed field and rejects unknown ones; an
    // expect-error directive that does not fire surfaces as TS2578 below.

    // @ts-expect-error - 'one' (from Mixin1) is required in the merged config
    const missingOne = Consumer.new({ two : 1, three : true })
    // @ts-expect-error - 'two' (from Mixin2) is required in the merged config
    const missingTwo = Consumer.new({ one : "x", three : true })
    // @ts-expect-error - 'three' (Consumer's own field) is required in the merged config
    const missingThree = Consumer.new({ one : "x", two : 1 })
    // @ts-expect-error - 'nope' is not a known config property
    const unexpected = Consumer.new({ one : "x", two : 1, three : true, nope : 0 })

    void [ created, missingOne, missingTwo, missingThree, unexpected ]
`)

it("tsserver reports no merge/config errors in the editor for a chain where a construction mixin overrides initialize and depends on another", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: chainText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                chainText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        // No TS2320 (the chain's `__Mixin2$base` merge is fixed) and no TS2578 (every
        // expect-error directive is used, i.e. the merged config requires each field and
        // rejects unknown ones).
        t.equal(
            diagnostics.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`).join("\n"),
            "",
            "A construction mixin in a chain is clean in the editor; the merged config requires every field and rejects unknown ones"
        )
    } finally {
        await fixture.dispose()
    }
})

// A plain class that extends a construction mixin directly and adds a required config
// field. Not the idiomatic pattern (prefer `implements`), but supported: the mixin's `new`
// is a (bivariant) method, so the subclass's `static new(props: EventConfig)` does not clash
// (TS2417). Guards the editor view (the emit-path probe alone would not cover source view).
const extendsMixinText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    @mixin()
    class Timestamped extends Base {
        public createdAt!: Date = new Date()
    }

    class Event extends Timestamped {
        public name!: string = ""
    }

    const created = Event.new({ createdAt : new Date(), name : "x" })

    // @ts-expect-error - 'name' is required in the subclass config
    const missingName = Event.new({ createdAt : new Date() })

    void [ created, missingName ]
`)

it("tsserver reports no static-side errors in the editor when a class extends a construction mixin and adds a required field", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: extendsMixinText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                extendsMixinText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        // No TS2417 (the static-side `new` stays assignable) and no TS2578 (the expect-error
        // fires, i.e. the subclass config really requires `name`).
        t.equal(
            diagnostics.map((diagnostic) => `TS${diagnostic.code}: ${diagnostic.text}`).join("\n"),
            "",
            "Extending a construction mixin and adding a required field is clean in the editor; the subclass config requires the field"
        )
    } finally {
        await fixture.dispose()
    }
})

// A `.new(...)` call missing a required config key, viewed in the EDITOR. A synthetic
// `<Name>Config` alias node has no real source text, so TypeScript's alias display
// (`declarationNameToString` -> reads the name node's SOURCE TEXT) would render it as a
// meaningless `}` (the class' closing brace it is anchored to). The transform fixes this
// NATIVELY: in source view it appends each generated alias as REAL text past the document
// end, so the checker reads the real `<Name>Config` name (the companion language-service
// plugin then filters / remaps the phantom navigation that appended text would create). This
// pins that the editor names the alias - the same `PointConfig` the emit plane reports.
const missingRequiredConfigText = trimIndent(`
    import { Base } from "ts-mixin-class/base"

    class Point extends Base {
        public readonly x!: number
        public readonly y!: number
        public label!: string = ""
    }

    // Missing the required \`x\` config key: the editor must name the config readably.
    const p = Point.new({ y : 2, label : "origin-ish" })
    void p
`)

it("tsserver names the config alias (PointConfig), not a meaningless `}`, for a failing .new(...) in the editor", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: missingRequiredConfigText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                missingRequiredConfigText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        const argError = diagnostics.filter((diagnostic) => diagnostic.code === 2345)
            .map((diagnostic) => diagnostic.text ?? "").join("\n")

        t.match(argError, "parameter of type 'PointConfig'",
            "The editor names the generated config alias (read from the appended real text)")
        t.notMatch(argError, "parameter of type '}'",
            "The editor never shows the meaningless `}` a synthetic alias name would print")
        t.notMatch(argError, "Pick<Point",
            "The alias name is shown, not the expanded structural Pick")
    } finally {
        await fixture.dispose()
    }
})

// A `.new(...)` missing a required config key, viewed in the EDITOR, where the config has BOTH
// required and optional fields. That combination makes the config type an INTERSECTION
// (`Pick<C, required> & Partial<Pick<C, optional>>`); TypeScript attaches the alias symbol only
// to the OUTERMOST node, so the nested "...but required in type X" elaboration would point at the
// inner `Pick<C, required>` constituent (carrying its own `Pick` alias) instead of the config
// alias. The transform flattens the intersection through a homomorphic mapped type, so the whole
// config carries the alias and every elaboration names `<Class>Config`. (An all-required config is
// a single `Pick` that already names the alias - this pins the required+optional intersection.)
const intersectionConfigMissingRequiredText = trimIndent(`
    import { mixin } from "ts-mixin-class"
    import { Base } from "ts-mixin-class/base"

    class Ledger extends Base {
        public baseValue!: string = "base"
    }

    @mixin()
    class Auditable {
        public mixinValue!: number = 0
    }

    class Account extends Ledger implements Auditable {
        public ownValue!: boolean = false
        public definiteOwnValue!: string
        public optionalOwnValue?: boolean
    }

    // Missing the required \`definiteOwnValue\`; \`optionalOwnValue?\` makes the config an intersection.
    const a = Account.new({ baseValue : "x", mixinValue : 1, ownValue : true })
    void a
`)

it("tsserver names the config alias in the NESTED 'required in type' elaboration too (a required+optional intersection config), not an expanded Pick", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [ { fileName: "source.ts", text: intersectionConfigMissingRequiredText } ]
    })

    try {
        const sourceFile  = requiredFixtureSourceFile(fixture.sourceFiles, "source.ts")
        const diagnostics = assertResponseBody<Array<{ code?: number, text?: string }>>(
            t,
            await runTypeScriptServerRequest(
                fixture.directory,
                sourceFile,
                intersectionConfigMissingRequiredText,
                "semanticDiagnosticsSync",
                { file: sourceFile }
            )
        )

        const argError = diagnostics.filter((diagnostic) => diagnostic.code === 2345)
            .map((diagnostic) => diagnostic.text ?? "").join("\n")

        t.match(argError, "parameter of type 'AccountConfig'",
            "The header names the generated config alias")
        t.match(argError, "required in type 'AccountConfig'",
            "The nested `required in type` elaboration also names the alias")
        t.notMatch(argError, "Pick<Account",
            "The nested elaboration never expands the alias to its structural Pick")
    } finally {
        await fixture.dispose()
    }
})
