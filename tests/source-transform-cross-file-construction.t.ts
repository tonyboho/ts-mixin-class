import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { commandOutput, createTypeScriptFixture, packageRoot, runCommand } from "./util.js"
import type { TypeScriptFixtureSourceFile } from "./util.js"

const tscBinary = path.join(packageRoot, "node_modules", "typescript", "bin", "tsc")

// Compiles a library through the transformer (emit), then returns its emitted `dist`
// output (`.d.ts` + `.js`) re-rooted under `node_modules/<packageName>/` so a separate
// consumer program can import the library the way a published package is consumed —
// through generated declarations only, never the library source.
async function buildDeclarationPackage(
    t: Test,
    packageName: string,
    libraryFiles: TypeScriptFixtureSourceFile[],
    // Dependency packages (previously built declaration packages) the library itself
    // consumes — a SECOND-generation package builds on top of a first-generation one.
    dependencyFiles: TypeScriptFixtureSourceFile[] = []
): Promise<TypeScriptFixtureSourceFile[]> {
    const library = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        extraFiles             : dependencyFiles,
        sourceFiles            : libraryFiles
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", library.tsconfigFile ], library.directory)

        t.isStrict(build.exitCode, 0, `Declaration package "${packageName}" builds:\n${commandOutput(build)}`)

        const distDirectory = path.join(library.directory, "dist")
        const emittedNames  = await readdir(distDirectory)
        const emitted       = await Promise.all(emittedNames.map(async (name) => ({
            fileName : `node_modules/${packageName}/${name}`,
            text     : await readFile(path.join(distDirectory, name), "utf8")
        })))

        // Expose each module as its own subpath export (`<pkg>/timestamp` ->
        // `timestamp.d.ts`/`timestamp.js`), like the package's own `./mixins` entry — a
        // consumer can then import from the declaring file OR through a re-exporting
        // barrel: both registries alias barrel keys onto the declaring file's entry.
        const exportsMap: Record<string, { types: string, default: string }> = {}

        for (const name of emittedNames) {
            if (name.endsWith(".js")) {
                const stem = name.slice(0, -3)

                exportsMap[`./${stem}`] = { types: `./${stem}.d.ts`, default: `./${stem}.js` }
            }
        }

        return [
            {
                fileName : `node_modules/${packageName}/package.json`,
                text     : JSON.stringify(
                    {
                        name    : packageName,
                        version : "0.0.0",
                        type    : "module",
                        exports : exportsMap
                    },
                    null,
                    4
                )
            },
            ...emitted
        ]
    } finally {
        await library.dispose()
    }
}

// Construction-base detection resolves the base chain across files through the
// cross-file registry: for ordinary classes extending an imported Base descendant,
// for consumers of an imported mixin whose required base is a Base descendant, and
// for consumers of an imported mixin that extends the package `Base` directly.

const providerText = `
    import { Base } from "ts-mixin-class/base"
    import { mixin } from "ts-mixin-class"

    export class AppBase extends Base {
        public appValue!: string = "app"
    }

    @mixin()
    export class FeatureMixin extends AppBase {
        featureMethod(): string {
            return this.appValue
        }
    }

    @mixin()
    export class DirectBaseMixin extends Base {
        public mixinValue!: number = 0
        public tag!: string = ""

        // A mixin can type its \`initialize\` override with its own strict config alias;
        // the consumer's generated \`$base\` interface re-declares the \`Base.initialize\`
        // protocol member, so merging several such mixins does not hit a TS2320 conflict.
        // The parameter is required (not \`config?:\`): a class with required config fields
        // is always constructed with a config, so \`initialize\` always receives one.
        override initialize(config: DirectBaseMixinConfig): void {
            super.initialize(config)

            // \`config\` is the strict \`DirectBaseMixinConfig\`, so its members are typed.
            const seedTag: string = config.tag

            void seedTag
            this.tag = "init:" + this.mixinValue
        }
    }

    @mixin()
    export class TagMixin {
        public label!: string = ""
    }

    // A construction *consumer* exported for another file to subclass. Its config
    // includes the consumed mixin's \`label\`, which the subclass's \`.new\` must see.
    export class TaggedBase extends Base implements TagMixin {
        public ownBaseValue!: string = ""
    }
`

it("regenerates construction members for an ordinary class extending an imported Base descendant", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "provider.ts", text: providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "./provider.js"

                    class OrdinaryDerived extends AppBase {
                        public ownValue!: number = 0
                    }

                    const instance = OrdinaryDerived.new({ appValue : "configured", ownValue : 7 })

                    const a: string = instance.appValue
                    const b: number = instance.ownValue

                    void [ a, b ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Ordinary cross-file Base descendant typechecks its regenerated new():\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// A FAILING `.new(...)` call (missing a required field) on a cross-file construction
// class must report an ordinary type error, never crash the compiler. The generated
// `static new` is an overload set; a failed call makes the checker elaborate against the
// (synthetic) implementation overload, computing an error span on its `new` name node —
// which has no source position in the position-preserving source-view tree, tripping a
// `Debug.assert` in `getErrorSpanForNode` (TS issue #20809). The name must carry a span
// the checker can resolve.
it("reports a failing cross-file `.new(...)` call as a type error without crashing the compiler", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "provider.ts", text: providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "./provider.js"

                    class OrdinaryDerived extends AppBase {
                        public ownValue!: number = 0
                    }

                    const bad = OrdinaryDerived.new({})

                    void bad
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)
        const output = commandOutput(result)

        t.notMatch(
            output,
            "Debug Failure",
            `A failing cross-file .new() must not crash the compiler:\n${output}`
        )
        t.notMatch(
            output,
            "20809",
            `A failing cross-file .new() must not trip the getErrorSpanForNode assertion:\n${output}`
        )
        t.match(
            output,
            /error TS2345|error TS2554/,
            `A failing cross-file .new() should report an ordinary argument type error:\n${output}`
        )
    } finally {
        await fixture.dispose()
    }
})

it("regenerates construction members for a consumer of an imported Base-descendant mixin", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "provider.ts", text: providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { FeatureMixin } from "./provider.js"

                    class FeatureConsumer implements FeatureMixin {
                        public ownFlag!: boolean = false
                    }

                    const instance = FeatureConsumer.new({ appValue : "configured", ownFlag : true })

                    const a: string = instance.appValue
                    const b: boolean = instance.ownFlag
                    const c: string = instance.featureMethod()

                    void [ a, b, c ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Consumer of a cross-file Base-descendant mixin typechecks its new():\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

it("supports a consumer of an imported mixin that extends Base directly, including its initialize override", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "provider.ts", text: providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { DirectBaseMixin } from "./provider.js"

                    class DirectConsumer implements DirectBaseMixin {
                        public ownFlag!: boolean = false
                    }

                    const instance = DirectConsumer.new({ mixinValue : 7, tag : "", ownFlag : true })

                    const a: number = instance.mixinValue
                    const b: boolean = instance.ownFlag

                    console.log("RESULT:" + JSON.stringify({ a, b, tag : instance.tag }))
                `
            }
        ]
    })

    try {
        const build = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            build.exitCode,
            0,
            `Consumer of a mixin that extends Base directly typechecks and emits:\n${commandOutput(build)}`
        )

        const run = await runCommand("node", [ path.join(fixture.directory, "dist", "consumer.js") ], fixture.directory)

        t.isStrict(run.exitCode, 0, `Emitted consumer runs:\n${commandOutput(run)}`)
        t.match(
            run.stdout,
            `RESULT:${JSON.stringify({ a: 7, b: true, tag: "init:7" })}`,
            "The mixin's initialize override (which calls super.initialize on Base) runs for the consumer"
        )
    } finally {
        await fixture.dispose()
    }
})

// Subclassing an imported construction *consumer* in another file: the subclass's
// generated `.new` must aggregate the imported base's config including the field
// contributed by the mixin that base consumes (`TaggedBase implements TagMixin`).
// The cross-file construction-base registry resolves the imported base's consumed
// mixins, not only its `extends` chain.
it("aggregates an imported construction consumer's mixin config when subclassed across files", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "provider.ts", text: providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { TaggedBase } from "./provider.js"

                    class TaggedSubclass extends TaggedBase {
                        public extra!: string = ""
                    }

                    // Passing the imported base's mixin field (\`label\`) must typecheck:
                    // if the registry dropped it, this would be a TS2353 unknown-property
                    // error. The local fixture (construction-deep-subclass) pins that the
                    // aggregated field is also *required*.
                    const instance = TaggedSubclass.new({ ownBaseValue : "x", label : "y", extra : "z" })

                    const a: string = instance.ownBaseValue
                    const b: string = instance.label
                    const c: string = instance.extra

                    void [ a, b, c ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Subclass of an imported construction consumer aggregates the base mixin's config field:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// Transitive mixin config across THREE files: a mixin in one file is consumed by a
// mixin in a second file (`Timestamp implements Audit`), and only the consumer lives
// in the third. The consumer's `.new` must aggregate the field two hops away
// (`auditField`) along with the direct mixin's and its own — resolved entirely through
// the cross-file mixin registry / linearization, not just one import level deep.
it("aggregates transitive mixin config for a consumer across three files", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "audit.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class Audit {
                        public auditField!: string = ""
                    }
                `
            },
            {
                fileName : "timestamp.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"
                    import { Base } from "ts-mixin-class/base"
                    import { Audit } from "./audit.js"

                    @mixin()
                    export class Timestamp extends Base implements Audit {
                        public timestampField!: number = 0
                    }
                `
            },
            {
                fileName : "consumer.ts",
                text     : `
                    import { Timestamp } from "./timestamp.js"

                    class Doc implements Timestamp {
                        public docField!: boolean = false
                    }

                    // Passing the two-hop transitive field (\`auditField\`, from audit.ts)
                    // must typecheck: if linearization dropped it, this would be a TS2353
                    // unknown-property error. The local construction-deep-subclass fixture
                    // pins that the aggregated field is also *required*.
                    const doc = Doc.new({ auditField : "a", timestampField : 1, docField : true })

                    const a: string = doc.auditField
                    const b: number = doc.timestampField
                    const c: boolean = doc.docField

                    void [ a, b, c ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Consumer aggregates transitive (two-hop) mixin config across three files:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// Transitive mixin config through the construction-base REGISTRY across files: an
// ordinary class extends `Base` and implements a mixin that itself depends on another
// mixin (`Model implements Timestamp`, `Timestamp implements Audit`), each in its own
// file; a fourth file subclasses the imported `Model`. The subclass's `.new` must see
// `auditField` — two mixin hops up from the imported base — proving the registry
// recurses an imported base's mixins AND their transitive dependencies.
it("aggregates transitive registry mixin config when subclassing an imported base across files", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            {
                fileName : "audit.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"

                    @mixin()
                    export class Audit {
                        public auditField!: string = ""
                    }
                `
            },
            {
                fileName : "timestamp.ts",
                text     : `
                    import { mixin } from "ts-mixin-class"
                    import { Audit } from "./audit.js"

                    @mixin()
                    export class Timestamp implements Audit {
                        public timestampField!: number = 0
                    }
                `
            },
            {
                fileName : "model.ts",
                text     : `
                    import { Base } from "ts-mixin-class/base"
                    import { Timestamp } from "./timestamp.js"

                    export class Model extends Base implements Timestamp {
                        public modelField!: string = ""
                    }
                `
            },
            {
                fileName : "admin.ts",
                text     : `
                    import { Model } from "./model.js"

                    class Admin extends Model {
                        public adminField!: boolean = false
                    }

                    // \`auditField\` is two mixin hops above the imported base \`Model\`
                    // (Model implements Timestamp implements Audit); accepting it proves the
                    // registry recursed the imported base's mixins and their dependencies.
                    const admin = Admin.new({
                        auditField     : "a",
                        timestampField : 1,
                        modelField     : "m",
                        adminField     : true
                    })

                    const a: string = admin.auditField
                    const b: number = admin.timestampField
                    const c: string = admin.modelField
                    const d: boolean = admin.adminField

                    void [ a, b, c, d ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Subclass aggregates transitive (two-hop) registry mixin config across four files:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// Construction config must survive the DECLARATION round-trip: the library is consumed
// as a published package through generated `.d.ts` (never its source). A construction-
// base mixin (`Timestamp extends Base`) that itself consumes another mixin
// (`implements Audit`) is constructed in a separate program via its own `Timestamp.new`.
// The aggregated, two-hop config (`auditField` from `Audit`) must be carried by the
// emitted `.d.ts` and accepted at the `.new` call across the package boundary.
it("carries transitive construction config through a declaration (.d.ts) package", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "construction-lib", [
        {
            fileName : "audit.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                @mixin()
                export class Audit {
                    public auditField!: string = ""
                }
            `
        },
        {
            fileName : "timestamp.ts",
            text     : `
                import { mixin } from "ts-mixin-class"
                import { Base } from "ts-mixin-class/base"
                import { Audit } from "./audit.js"

                @mixin()
                export class Timestamp extends Base implements Audit {
                    public timestampField!: number = 0
                }
            `
        }
    ])

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { Timestamp } from "construction-lib/timestamp"

                    // \`auditField\` comes from the declaration package two mixin hops away
                    // (Timestamp implements Audit); accepting it at the construction-base
                    // mixin's own \`.new\` proves the aggregated config survives the .d.ts.
                    const instance = Timestamp.new({ auditField : "a", timestampField : 1 })

                    const a: string = instance.auditField
                    const b: number = instance.timestampField

                    void [ a, b ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Consumer of a declaration (.d.ts) construction package aggregates transitive mixin config:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// A downstream class that `implements` an imported `.d.ts` construction-base mixin must
// itself become construction-enabled: it gets its own generated `.new`, whose config
// aggregates the mixin's fields (and the mixin's transitive `Audit` field) plus its own.
// This requires recovering the required-base / package-base flags from the declaration
// file's `RuntimeMixinClass<Base>` marker (they are otherwise dropped for `.d.ts`).
it("makes a consumer of a declaration (.d.ts) construction-base mixin construction-enabled", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "construction-lib", [
        {
            fileName : "audit.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                @mixin()
                export class Audit {
                    public auditField!: string = ""
                }
            `
        },
        {
            fileName : "timestamp.ts",
            text     : `
                import { mixin } from "ts-mixin-class"
                import { Base } from "ts-mixin-class/base"
                import { Audit } from "./audit.js"

                @mixin()
                export class Timestamp extends Base implements Audit {
                    public timestampField!: number = 0
                }
            `
        }
    ])

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { Timestamp } from "construction-lib/timestamp"

                    class Doc implements Timestamp {
                        public docField!: boolean = false
                    }

                    const doc = Doc.new({ auditField : "a", timestampField : 1, docField : true })

                    const a: string = doc.auditField
                    const b: number = doc.timestampField
                    const c: boolean = doc.docField

                    void [ a, b, c ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Consumer of a .d.ts construction-base mixin gets its own .new with aggregated config:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// An ordinary class that EXTENDS an imported `.d.ts` construction base (a plain
// `class AppBase extends Base`, published as declarations) must be recognised as a
// construction base too: the subclass gets its own `.new` aggregating the inherited
// config. The construction-base registry must resolve declaration-file bases, not only
// source files.
it("makes a subclass of an imported declaration (.d.ts) construction base construction-enabled", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "app-base-lib", [
        {
            fileName : "app-base.ts",
            text     : `
                import { Base } from "ts-mixin-class/base"

                export class AppBase extends Base {
                    public appValue!: string = ""
                }
            `
        }
    ])

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "app-base-lib/app-base"

                    class Widget extends AppBase {
                        public ownValue!: number = 0
                    }

                    const widget = Widget.new({ appValue : "x", ownValue : 7 })

                    const a: string = widget.appValue
                    const b: number = widget.ownValue

                    void [ a, b ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Subclass of a .d.ts construction base gets its own .new with aggregated config:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// A construction base reaches its subclass THROUGH A BARREL: the import resolves to the
// re-exporting file, so the registry must expose the entry under the barrel's key too
// (the mixin registry's re-export alias walk, applied to construction bases). Covers
// both halves: Widget's own expansion (final-registry alias) and Widget's REGISTRATION
// for further subclassing (candidate-map alias — Gadget extends Widget directly, and
// consumer.ts itself never mentions the package, so its admission also rides the alias).
it("makes a subclass construction-enabled through an `export *` barrel, transitively", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "provider.ts", text: providerText },
            { fileName: "barrel.ts", text: `export * from "./provider.js"` },
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "./barrel.js"

                    export class Widget extends AppBase {
                        public ownValue!: number = 0
                    }

                    const widget = Widget.new({ appValue : "x", ownValue : 7 })

                    const a: string = widget.appValue
                    const b: number = widget.ownValue

                    void [ a, b ]
                `
            },
            {
                fileName : "gadget.ts",
                text     : `
                    import { Widget } from "./consumer.js"

                    class Gadget extends Widget {
                        public gadgetValue!: boolean = false
                    }

                    const gadget = Gadget.new({ appValue : "x", ownValue : 7, gadgetValue : true })

                    const c: boolean = gadget.gadgetValue

                    void c
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Construction survives an export-* barrel, two subclass generations deep:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// The NAMED, ALIASED re-export form of the same route: the barrel key carries the
// EXPORTED name (`PlatformBase`), not the declaring one.
it("makes a subclass construction-enabled through a named, aliased re-export", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName: "provider.ts", text: providerText },
            { fileName: "barrel.ts", text: `export { AppBase as PlatformBase } from "./provider.js"` },
            {
                fileName : "consumer.ts",
                text     : `
                    import { PlatformBase } from "./barrel.js"

                    class Widget extends PlatformBase {
                        public ownValue!: number = 0
                    }

                    const widget = Widget.new({ appValue : "x", ownValue : 7 })

                    const a: string = widget.appValue
                    const b: number = widget.ownValue

                    void [ a, b ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Construction survives a named aliased re-export:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// The same route across a PACKAGE boundary: a published declaration package whose
// entry point is an `export *` barrel `.d.ts`. The declaring `.d.ts` registers the
// entry; the barrel key must alias it for the consumer's import to resolve.
it("makes a subclass of a declaration (.d.ts) construction base construction-enabled through the package's barrel", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "barrel-base-lib", [
        {
            fileName : "app-base.ts",
            text     : `
                import { Base } from "ts-mixin-class/base"

                export class AppBase extends Base {
                    public appValue!: string = ""
                }
            `
        },
        {
            fileName : "index.ts",
            text     : `export * from "./app-base.js"`
        }
    ])

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "barrel-base-lib/index"

                    class Widget extends AppBase {
                        public ownValue!: number = 0
                    }

                    const widget = Widget.new({ appValue : "x", ownValue : 7 })

                    const a: string = widget.appValue
                    const b: number = widget.ownValue

                    void [ a, b ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Construction survives a declaration-package export-* barrel:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// REVERSED (pure-type-composition epic, decision 1): computed keys now RIDE across source
// files — the consumer's config references the contributor's `<Name>Config` alias through
// a generated type-only import, and the alias spells its computed keys in ITS OWN scope,
// so no transplanting ever happens. §10.25's "deliberately omitted" strip rule dissolves:
// the keys keep their identity, VALUE types and REQUIREDNESS downstream.
it("carries computed config keys across source files through the composed alias", async (t: Test) => {
    const sourceFiles: TypeScriptFixtureSourceFile[] = [
        {
            fileName : "exotic.ts",
            text     : `
                import { Base, mixin } from "ts-mixin-class"

                export const computed = "computed" as const
                export const symbolic: unique symbol = Symbol("symbolic")

                @mixin()
                export class Exotic extends Base {
                    public 0!: string
                    public "dash-name"!: number
                    public [computed]!: boolean
                    public [symbolic]!: boolean
                }
            `
        },
        {
            fileName : "consumer.ts",
            text     : `
                import { Exotic, computed, symbolic } from "./exotic.js"

                class Holder implements Exotic {
                    public own!: Date = new Date(0)
                }

                const value = Holder.new({
                    0           : "zero",
                    "dash-name" : 1,
                    [computed]  : true,
                    [symbolic]  : true,
                    own         : new Date(0)
                })

                const literal: string = value[0]
                const dashed: number = value["dash-name"]
                const computedValue: boolean = value[computed]
                const symbolicValue: boolean = value[symbolic]

                function typeOnlyChecks(): void {
                    // @ts-expect-error the imported REQUIRED computed keys stay required across files
                    Holder.new({ 0: "zero", "dash-name": 1, own: new Date(0) })

                    // @ts-expect-error the computed key's value type constrains across files
                    Holder.new({ 0: "zero", "dash-name": 1, [computed]: 1, [symbolic]: true, own: new Date(0) })
                }

                void [ literal, dashed, computedValue, symbolicValue, typeOnlyChecks ]
            `
        }
    ]

    for (const [ plane, compilerOptions ] of [
        [ "emit", undefined ],
        [ "source view", { noEmit: true } ]
    ] as const) {
        const fixture = await createTypeScriptFixture({
            experimentalDecorators : false,
            compilerOptions,
            sourceFiles
        })

        try {
            const result = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

            t.isStrict(
                result.exitCode,
                0,
                `${plane}: cross-file config transport keeps spellable keys and drops scoped computed keys:\n${commandOutput(result)}`
            )
        } finally {
            await fixture.dispose()
        }
    }
})

it("carries exotic construction config shapes through a declaration package", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "exotic-construction-lib", [
        {
            fileName : "exotic.ts",
            text     : `
                import { Base, mixin } from "ts-mixin-class"

                export const computed = "computed" as const
                export const symbolic: unique symbol = Symbol("symbolic")

                @mixin()
                export class Exotic extends Base {
                    public 0!: string
                    public "dash-name"!: number
                    public [computed]!: boolean
                    public [symbolic]!: boolean
                }

                export class ExoticBag extends Base {
                    [index: number]: string
                    [key: symbol]: boolean
                }
            `
        }
    ])

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { Exotic, ExoticBag, computed, symbolic } from "exotic-construction-lib/exotic"

                    const standalone = Exotic.new({
                        0           : "zero",
                        "dash-name" : 1,
                        computed    : true,
                        [symbolic]  : false
                    })

                    class Holder implements Exotic {
                        public own!: Date = new Date(0)
                    }

                    const consumed = Holder.new({
                        0           : "zero",
                        "dash-name" : 1,
                        computed    : true,
                        [symbolic]  : false,
                        own         : new Date(0)
                    })

                    class BagChild extends ExoticBag {
                        public own!: Date
                    }

                    const bag = ExoticBag.new({ 1: "one", [Symbol("flag")]: true })
                    const bagChild = BagChild.new({ 1: "one", [Symbol("flag")]: true, own: new Date(0) })

                    const a: number = consumed["dash-name"]
                    const b: boolean = consumed[computed]
                    const c: boolean = consumed[symbolic]
                    const d: string = bag[1]
                    const e: Date = bagChild.own

                    function typeOnlyChecks(): void {
                        // @ts-expect-error the numeric index remains string-valued through .d.ts
                        Exotic.new({ 0: 1, "dash-name": 1, computed: true, [symbolic]: false })

                        // @ts-expect-error the unique-symbol key keeps its boolean value type
                        Exotic.new({ 0: "zero", "dash-name": 1, computed: true, [symbolic]: "wrong" })
                    }

                    void [ standalone, a, b, c, d, e, typeOnlyChecks ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Declaration consumers retain literal, computed, symbol and index config shapes:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// REVERSED (pure-type-composition epic, decision 2): a default-exported construction value
// is BANNED (TS990016) instead of supported through declarations. Its `<Name>Config`
// companion cannot be exported (§7.15 keeps a default export's alias module-local) — the one
// structural hole in companion-alias nameability, so the alias-route config transport would
// have no name to import. A default-exported NON-construction mixin stays legal (no
// companion to export — `package-default-consumer.t.ts` keeps pinning that).
it("rejects default-exported construction classes and mixins at build time", async (t: Test) => {
    const defaultBase  = {
        fileName : "default-base.ts",
        text     : `
            import { Base } from "ts-mixin-class/base"

            export default class DefaultBase extends Base {
                public baseKey!: string = ""
            }
        `
    }
    const defaultMixin = {
        fileName : "default-mixin.ts",
        text     : `
            import { Base, mixin } from "ts-mixin-class"

            @mixin()
            export default class DefaultMixin extends Base {
                public mixinKey!: number = 0
            }
        `
    }

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : [ defaultBase, defaultMixin ]
    })

    try {
        const emit       = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)
        const emitOutput = commandOutput(emit)

        t.ne(emit.exitCode, 0, "emit: rejected")
        t.match(emitOutput, "TS990016", `a native diagnostic bans the default export.\n${emitOutput}`)
        t.match(emitOutput, "DefaultBase", "the plain construction base is named")
        t.match(emitOutput, "DefaultMixin", "the construction mixin is named")
        t.match(emitOutput, "named export", "the message points at the fix")

        const sourceView       = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)
        const sourceViewOutput = commandOutput(sourceView)

        t.ne(sourceView.exitCode, 0, "source view: rejected identically")
        t.match(sourceViewOutput, "TS990016", `both planes agree.\n${sourceViewOutput}`)
    } finally {
        await fixture.dispose()
    }
})

it("preserves overloaded constructors and exotic statics through a declaration package", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "declaration-shapes-lib", [
        {
            fileName : "shapes.ts",
            text     : `
                import { mixin } from "ts-mixin-class"

                export const staticToken: unique symbol = Symbol("staticToken")

                @mixin()
                export class DeclarationShapes {
                    static state: string = "initial"

                    constructor()
                    constructor(seed: string)
                    constructor(seed: string = "initial") {
                        DeclarationShapes.state = seed
                    }

                    static identity<T>(value: T): T {
                        return value
                    }

                    static parse(value: string): string
                    static parse(value: number): number
                    static parse(value: string | number): string | number {
                        return value
                    }

                    static get current(): string {
                        return this.state
                    }

                    static set current(value: string) {
                        this.state = value
                    }

                    static [staticToken](): string {
                        return "symbol"
                    }
                }
            `
        }
    ])

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [
            {
                fileName : "consumer.ts",
                text     : `
                    import { DeclarationShapes, staticToken } from "declaration-shapes-lib/shapes"

                    const first = new DeclarationShapes()
                    const second = new DeclarationShapes("seed")

                    class Consumer implements DeclarationShapes {
                    }

                    const generic: { value: number } = Consumer.identity({ value: 1 })
                    const parsedString: string = Consumer.parse("x")
                    const parsedNumber: number = Consumer.parse(1)

                    Consumer.current = "changed"

                    const current: string = Consumer.current
                    const symbolResult: string = Consumer[staticToken]()

                    // BY DESIGN: a mixin VALUE's construct signature is deliberately
                    // PERMISSIVE (MixinClassValue's \`new (...args: any[])\` — a mixin value
                    // is primarily an appliable factory; §2.16 direct subclassing works but
                    // is loosely typed), so a mis-typed direct \`new\` is NOT rejected
                    // through the published value. Pinned so a shape change is noticed.
                    const permissive = new DeclarationShapes(1)

                    function typeOnlyChecks(): void {
                        // @ts-expect-error the published static overloads reject booleans
                        Consumer.parse(true)

                        // @ts-expect-error the published accessor keeps its string setter type
                        Consumer.current = 1
                    }

                    void [ first, second, generic, parsedString, parsedNumber, current, symbolResult, permissive, typeOnlyChecks ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `Declaration consumers retain constructor overloads and every static member shape:\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

// The pure-type composition, CROSS-FILE stage (epic decision 1): an imported contributor
// with an available `<Name>Config` alias joins the downstream config as a generated
// TYPE-ONLY import (`import type { SortableConfig as __Sortable$config } from …`) instead
// of a re-spelled fact list. This carries what the fact transport never could: computed
// (unique-symbol) keys keep their identity AND requiredness across files, and a GENERIC
// contributor instantiates at the use site.
it("an imported construction mixin's config joins by alias — computed keys and requiredness ride it", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : [
            {
                fileName : "provider.ts",
                text     : `
                    import { Base, mixin } from "ts-mixin-class"

                    export const prioKey: unique symbol = Symbol("prioKey")

                    @mixin()
                    export class Sortable extends Base {
                        public order!: number
                        public [prioKey]!: number
                    }

                    @mixin()
                    export class Boxed<T> extends Base {
                        public value!: T
                    }
                `
            },
            {
                fileName : "consumer.ts",
                text     : `
                    import { prioKey, Sortable, Boxed } from "./provider.js"

                    export class Widget implements Sortable {
                        public label!: string
                    }

                    export class StringBox implements Boxed<string> {
                        public own!: number
                    }

                    const widget = Widget.new({ label: "l", order: 1, [prioKey]: 2 })
                    const box = StringBox.new({ own: 1, value: "s" })

                    const readPrio: number = widget[prioKey]
                    const readValue: string = box.value

                    function typeOnlyChecks(): void {
                        // @ts-expect-error the imported REQUIRED computed key stays required across files
                        Widget.new({ label: "l", order: 1 })

                        // @ts-expect-error the generic contributor instantiates at the use site
                        StringBox.new({ own: 1, value: 42 })
                    }

                    void [ widget, box, readPrio, readValue, typeOnlyChecks ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `imported computed keys and generic instantiation ride the composed alias:\n${commandOutput(result)}`
        )

        const consumerDeclaration = await readFile(path.join(fixture.directory, "dist", "consumer.d.ts"), "utf8")

        t.match(consumerDeclaration, "SortableConfig", "the consumer's config references the imported alias by name")
        t.match(consumerDeclaration, "BoxedConfig", "the generic contributor's alias is referenced")
        t.match(consumerDeclaration, "<string>", "…instantiated with the use-site argument")
        t.notMatch(
            consumerDeclaration,
            "NonNullable<Parameters<",
            "the §13.8 value-route carrier is gone — the alias route replaced it wholesale"
        )
    } finally {
        await fixture.dispose()
    }
})

it("a subclass of an imported construction base joins the parent's config by alias", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : [
            {
                fileName : "parent.ts",
                text     : `
                    import { Base } from "ts-mixin-class/base"

                    export class AppBase extends Base {
                        public appValue!: string
                    }
                `
            },
            {
                fileName : "child.ts",
                text     : `
                    import { AppBase } from "./parent.js"

                    export class Child extends AppBase {
                        public ownValue!: number
                    }

                    const child = Child.new({ appValue: "a", ownValue: 1 })

                    function typeOnlyChecks(): void {
                        // @ts-expect-error the parent's required key rides the referenced alias
                        Child.new({ ownValue: 1 })
                    }

                    void [ child, typeOnlyChecks ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(result.exitCode, 0, `the subclass composes over the imported parent alias:\n${commandOutput(result)}`)

        const childDeclaration = await readFile(path.join(fixture.directory, "dist", "child.d.ts"), "utf8")

        t.match(childDeclaration, "AppBaseConfig", "the child's config references the imported parent's alias")
        t.notMatch(childDeclaration, '"appValue" | "ownValue"', "the parent's keys are not re-spelled at the child")
    } finally {
        await fixture.dispose()
    }
})

it("a GENERIC declaration-package contributor's exotic config keys reach the downstream config through the alias", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "generic-exotic-lib", [ {
        fileName : "boxed.ts",
        text     : `
            import { Base, mixin } from "ts-mixin-class"

            export const stamp: unique symbol = Symbol("stamp")

            @mixin()
            export class Boxed<T> extends Base {
                public value!: T
                public [stamp]!: number
            }
        `
    } ])

    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [ {
            fileName : "consumer.ts",
            text     : `
                import { Boxed, stamp } from "generic-exotic-lib/boxed"

                class NumberBox implements Boxed<number> {
                    public own!: string
                }

                const box = NumberBox.new({ own: "o", value: 1, [stamp]: 7 })

                function typeOnlyChecks(): void {
                    // @ts-expect-error the published REQUIRED unique-symbol key stays required — even on a GENERIC use
                    NumberBox.new({ own: "o", value: 1 })

                    // @ts-expect-error the published generic instantiates at the use site
                    NumberBox.new({ own: "o", value: "wrong", [stamp]: 7 })
                }

                void [ box, typeOnlyChecks ]
            `
        } ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(
            result.exitCode,
            0,
            `the generic .d.ts contributor's exotic keys ride the imported alias (the pre-epic gap):\n${commandOutput(result)}`
        )
    } finally {
        await fixture.dispose()
    }
})

it("imported EMPTY contributors never ride the composed config by alias", async (t: Test) => {
    // The empty contributor's own alias is the exact-empty idiom
    // (`Partial<Record<PropertyKey, never>>`, §7.25) — referenced as a layer it would type
    // every key of the composed config `undefined`. The registry's inventory proves it
    // empty, so the layer contributes nothing instead.
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration: true },
        sourceFiles            : [
            {
                fileName : "blank.ts",
                text     : `
                    import { Base, mixin } from "ts-mixin-class"

                    export class Blank extends Base {
                    }

                    @mixin()
                    export class Tag extends Base {
                    }
                `
            },
            {
                fileName : "user.ts",
                text     : `
                    import { Blank, Tag } from "./blank.js"

                    export class Doc extends Blank implements Tag {
                        public title!: string
                    }

                    const doc = Doc.new({ title: "x" })

                    function typeOnlyChecks(): void {
                        // @ts-expect-error unknown keys are still rejected
                        Doc.new({ title: "x", junk: 1 })
                    }

                    void [ doc, typeOnlyChecks ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "-p", fixture.tsconfigFile ], fixture.directory)

        t.isStrict(result.exitCode, 0, `construction over imported empty contributors typechecks:\n${commandOutput(result)}`)

        const userDeclaration = await readFile(path.join(fixture.directory, "dist", "user.d.ts"), "utf8")

        t.notMatch(userDeclaration, "BlankConfig", "the empty parent's alias does not ride the composed config")
        t.notMatch(userDeclaration, "TagConfig", "the empty mixin's alias does not ride the composed config")
    } finally {
        await fixture.dispose()
    }
})

it("a declaration-package EMPTY contributor is dropped through its meta inventory", async (t: Test) => {
    const packageFiles = await buildDeclarationPackage(t, "hollow-lib", [ {
        fileName : "hollow.ts",
        text     : `
            import { Base } from "ts-mixin-class/base"

            export class Hollow extends Base {
            }
        `
    } ])

    const consumer = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : packageFiles,
        sourceFiles            : [
            {
                fileName : "app.ts",
                text     : `
                    import { Hollow } from "hollow-lib/hollow"

                    export class App extends Hollow {
                        public own!: string
                    }

                    const app = App.new({ own: "x" })

                    function typeOnlyChecks(): void {
                        // @ts-expect-error unknown keys are still rejected
                        App.new({ own: "x", junk: 1 })
                    }

                    void [ app, typeOnlyChecks ]
                `
            }
        ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", consumer.tsconfigFile ], consumer.directory)

        t.isStrict(result.exitCode, 0, `construction over a declaration-package empty parent typechecks:\n${commandOutput(result)}`)
    } finally {
        await consumer.dispose()
    }
})

it("a SECOND-generation declaration package stays construction-enabled and keeps its inherited exotic config", async (t: Test) => {
    // Generation 1: a construction base with computed keys (a REQUIRED unique symbol and
    // an optional const-string key). Its own emit is exact: config, meta, everything.
    const firstGeneration = await buildDeclarationPackage(t, "gen-one", [ {
        fileName : "tagged.ts",
        text     : `
            import { Base } from "ts-mixin-class/base"

            export const priority = Symbol("priority")
            export const kind = "meta-kind"

            export class Tagged extends Base {
                public [priority]!: number
                public [kind]: string = ""
            }
        `
    } ])

    // Generation 2: a keyless subclass published as its own package. Its `.d.ts` does not
    // mention the transformer package anywhere (it only imports gen-one), and its meta
    // cannot respell gen-one's computed keys — both traps at once.
    const secondGeneration = await buildDeclarationPackage(
        t,
        "gen-two",
        [ {
            fileName : "middle.ts",
            text     : `
            import { Tagged } from "gen-one/tagged"

            export class Middle extends Tagged {
            }
        `
        } ],
        firstGeneration
    )

    const middleDeclaration = secondGeneration.find((file) => file.fileName.endsWith("middle.d.ts"))!.text

    t.match(middleDeclaration, "static new", "the second generation IS construction-expanded")

    const app = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : [ ...firstGeneration, ...secondGeneration ],
        sourceFiles            : [ {
            fileName : "leaf.ts",
            text     : `
                import { Middle } from "gen-two/middle"
                import { priority } from "gen-one/tagged"

                export class Leaf extends Middle {
                    public own!: string
                }

                const leaf = Leaf.new({ own: "x", [priority]: 1 })

                function typeOnlyChecks(): void {
                    // @ts-expect-error the symbol key stays REQUIRED two package generations up
                    Leaf.new({ own: "x" })
                }

                void [ leaf, typeOnlyChecks ]
            `
        } ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", app.tsconfigFile ], app.directory)

        t.isStrict(result.exitCode, 0, `construction typing survives two declaration-package generations:\n${commandOutput(result)}`)
    } finally {
        await app.dispose()
    }
})

it("a consumer's meta COMPOSES its contributors' metas — the inherited exotic inventory stays exact by reference", async (t: Test) => {
    // Generation 1: computed keys with a NARROW value type on the required symbol key.
    const firstGeneration = await buildDeclarationPackage(t, "meta-gen-one", [ {
        fileName : "tagged.ts",
        text     : `
            import { Base } from "ts-mixin-class/base"

            export const priority = Symbol("priority")
            export const kind = "meta-kind"

            export class Tagged extends Base {
                public [priority]!: 1 | 2
                public [kind]: string = ""
            }
        `
    } ])

    // Generation 2: a keyless subclass. Its meta cannot RESPELL gen-one's computed keys
    // (foreign-scope entities), so it must reference gen-one's meta instead of publishing
    // an under-reporting literal `never`.
    const secondGeneration = await buildDeclarationPackage(
        t,
        "meta-gen-two",
        [ {
            fileName : "middle.ts",
            text     : `
            import { Tagged } from "meta-gen-one/tagged"

            export class Middle extends Tagged {
            }
        `
        } ],
        firstGeneration
    )

    const middleDeclaration = secondGeneration.find((file) => file.fileName.endsWith("middle.d.ts"))!.text

    t.match(middleDeclaration, '$configMeta["keys"]', "the meta's keys reference the contributor's meta")
    t.match(middleDeclaration, '$configMeta["requiredKeys"]', "the meta's requiredKeys reference the contributor's meta")
    t.notMatch(middleDeclaration, "readonly keys: never", "the key inventory is no longer under-reported")

    // Generation 3, published as a package too: its meta must reference GENERATION 2's
    // meta alongside its own literal key — transitivity, and the proof that the reader
    // RESOLVED generation 2's references (an unresolved layer would read as key-free and
    // emit no reference of its own).
    const thirdGeneration = await buildDeclarationPackage(
        t,
        "meta-gen-three",
        [ {
            fileName : "leaf.ts",
            text     : `
            import { Middle } from "meta-gen-two/middle"

            export class Leaf extends Middle {
                public own!: string
            }
        `
        } ],
        [ ...firstGeneration, ...secondGeneration ]
    )

    const leafDeclaration = thirdGeneration.find((file) => file.fileName.endsWith("leaf.d.ts"))!.text

    t.match(leafDeclaration, '"own" | __Middle$configMeta["keys"]', "the third generation spells its own key and references the second's meta")
    t.match(leafDeclaration, '"own" | __Middle$configMeta["requiredKeys"]', "requiredness composes by reference too")

    // Generation 4, a source consumer: construction typing through the whole chain.
    const app = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : [ ...firstGeneration, ...secondGeneration, ...thirdGeneration ],
        sourceFiles            : [ {
            fileName : "consumer.ts",
            text     : `
                import { Leaf } from "meta-gen-three/leaf"
                import { priority } from "meta-gen-one/tagged"

                export class App extends Leaf {
                    public appValue: boolean = false
                }

                const app = App.new({ own: "x", [priority]: 1, appValue: true })

                function typeOnlyChecks(): void {
                    // @ts-expect-error the symbol key stays REQUIRED three package generations up
                    App.new({ own: "x" })
                }

                void [ app, typeOnlyChecks ]
            `
        } ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", app.tsconfigFile ], app.directory)

        t.isStrict(result.exitCode, 0, `construction typing holds through three composed package generations:\n${commandOutput(result)}`)
    } finally {
        await app.dispose()
    }
})

it("an index-only declaration ancestor's bag constraint survives a keyless middle package", async (t: Test) => {
    // The residual §7.31 hazard: the keyless middle's meta used to read `keys: never,
    // indexKinds: never` (own-only) — a FALSE emptiness proof, dropping the alias and the
    // ancestor's index-signature constraint with it. The composed meta references the
    // ancestor's `indexKinds` instead, so the middle never reads provably empty.
    const firstGeneration = await buildDeclarationPackage(t, "bag-gen-one", [ {
        fileName : "baggy.ts",
        text     : `
            import { Base } from "ts-mixin-class/base"

            export class Baggy extends Base {
                [bag: string]: number | Base["initialize"] | undefined
            }
        `
    } ])

    const secondGeneration = await buildDeclarationPackage(
        t,
        "bag-gen-two",
        [ {
            fileName : "mid.ts",
            text     : `
            import { Baggy } from "bag-gen-one/baggy"

            export class Mid extends Baggy {
            }
        `
        } ],
        firstGeneration
    )

    const midDeclaration = secondGeneration.find((file) => file.fileName.endsWith("mid.d.ts"))!.text

    t.match(midDeclaration, '$configMeta["indexKinds"]', "the middle's meta composes the ancestor's index kinds by reference")

    const app = await createTypeScriptFixture({
        experimentalDecorators : false,
        extraFiles             : [ ...firstGeneration, ...secondGeneration ],
        sourceFiles            : [ {
            fileName : "leaf.ts",
            text     : `
                import { Mid } from "bag-gen-two/mid"

                export class Leaf extends Mid {
                    public own!: number
                }

                const leaf = Leaf.new({ own: 1, extra: 2 })

                function typeOnlyChecks(): void {
                    // @ts-expect-error bag keys stay constrained by the ancestor's index signature
                    Leaf.new({ own: 1, extra: "wrong" })
                }

                void [ leaf, typeOnlyChecks ]
            `
        } ]
    })

    try {
        const result = await runCommand("node", [ tscBinary, "--noEmit", "-p", app.tsconfigFile ], app.directory)

        t.isStrict(result.exitCode, 0, `the index-signature constraint survives the keyless middle package:\n${commandOutput(result)}`)
    } finally {
        await app.dispose()
    }
})
