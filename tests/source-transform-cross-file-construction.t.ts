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
    libraryFiles: TypeScriptFixtureSourceFile[]
): Promise<TypeScriptFixtureSourceFile[]> {
    const library = await createTypeScriptFixture({
        experimentalDecorators : false,
        compilerOptions        : { declaration : true },
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
        // `timestamp.d.ts`/`timestamp.js`), like the package's own `./mixins` entry. A
        // consumer must import a mixin from the file that DECLARES it, not through a
        // re-exporting barrel: the mixin registry keys entries by their defining file, so
        // a barrel re-export would resolve the import to the barrel and miss the entry.
        const exportsMap: Record<string, { types: string, default: string }> = {}

        for (const name of emittedNames) {
            if (name.endsWith(".js")) {
                const stem = name.slice(0, -3)

                exportsMap[`./${stem}`] = { types : `./${stem}.d.ts`, default : `./${stem}.js` }
            }
        }

        return [
            {
                fileName : `node_modules/${packageName}/package.json`,
                text     : JSON.stringify({
                    name    : packageName,
                    version : "0.0.0",
                    type    : "module",
                    exports : exportsMap
                }, null, 4)
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
        public appValue: string = "app"
    }

    @mixin()
    export class FeatureMixin extends AppBase {
        featureMethod(): string {
            return this.appValue
        }
    }

    @mixin()
    export class DirectBaseMixin extends Base {
        public mixinValue: number = 0
        public tag: string = ""

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
        public label: string = ""
    }

    // A construction *consumer* exported for another file to subclass. Its config
    // includes the consumed mixin's \`label\`, which the subclass's \`.new\` must see.
    export class TaggedBase extends Base implements TagMixin {
        public ownBaseValue: string = ""
    }
`

it("regenerates construction members for an ordinary class extending an imported Base descendant", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "./provider.js"

                    class OrdinaryDerived extends AppBase {
                        public ownValue: number = 0
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

        t.isStrict(result.exitCode, 0,
            `Ordinary cross-file Base descendant typechecks its regenerated new():\n${commandOutput(result)}`)
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
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { AppBase } from "./provider.js"

                    class OrdinaryDerived extends AppBase {
                        public ownValue: number = 0
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

        t.notMatch(output, "Debug Failure",
            `A failing cross-file .new() must not crash the compiler:\n${output}`)
        t.notMatch(output, "20809",
            `A failing cross-file .new() must not trip the getErrorSpanForNode assertion:\n${output}`)
        t.match(output, /error TS2345|error TS2554/,
            `A failing cross-file .new() should report an ordinary argument type error:\n${output}`)
    } finally {
        await fixture.dispose()
    }
})

it("regenerates construction members for a consumer of an imported Base-descendant mixin", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { FeatureMixin } from "./provider.js"

                    class FeatureConsumer implements FeatureMixin {
                        public ownFlag: boolean = false
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

        t.isStrict(result.exitCode, 0,
            `Consumer of a cross-file Base-descendant mixin typechecks its new():\n${commandOutput(result)}`)
    } finally {
        await fixture.dispose()
    }
})

it("supports a consumer of an imported mixin that extends Base directly, including its initialize override", async (t: Test) => {
    const fixture = await createTypeScriptFixture({
        experimentalDecorators : false,
        sourceFiles            : [
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { DirectBaseMixin } from "./provider.js"

                    class DirectConsumer implements DirectBaseMixin {
                        public ownFlag: boolean = false
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

        t.isStrict(build.exitCode, 0,
            `Consumer of a mixin that extends Base directly typechecks and emits:\n${commandOutput(build)}`)

        const run = await runCommand("node", [ path.join(fixture.directory, "dist", "consumer.js") ], fixture.directory)

        t.isStrict(run.exitCode, 0, `Emitted consumer runs:\n${commandOutput(run)}`)
        t.match(run.stdout, `RESULT:${JSON.stringify({ a : 7, b : true, tag : "init:7" })}`,
            "The mixin's initialize override (which calls super.initialize on Base) runs for the consumer")
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
            { fileName : "provider.ts", text : providerText },
            {
                fileName : "consumer.ts",
                text     : `
                    import { TaggedBase } from "./provider.js"

                    class TaggedSubclass extends TaggedBase {
                        public extra: string = ""
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

        t.isStrict(result.exitCode, 0,
            `Subclass of an imported construction consumer aggregates the base mixin's config field:\n${commandOutput(result)}`)
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
                        public auditField: string = ""
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
                        public timestampField: number = 0
                    }
                `
            },
            {
                fileName : "consumer.ts",
                text     : `
                    import { Timestamp } from "./timestamp.js"

                    class Doc implements Timestamp {
                        public docField: boolean = false
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

        t.isStrict(result.exitCode, 0,
            `Consumer aggregates transitive (two-hop) mixin config across three files:\n${commandOutput(result)}`)
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
                        public auditField: string = ""
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
                        public timestampField: number = 0
                    }
                `
            },
            {
                fileName : "model.ts",
                text     : `
                    import { Base } from "ts-mixin-class/base"
                    import { Timestamp } from "./timestamp.js"

                    export class Model extends Base implements Timestamp {
                        public modelField: string = ""
                    }
                `
            },
            {
                fileName : "admin.ts",
                text     : `
                    import { Model } from "./model.js"

                    class Admin extends Model {
                        public adminField: boolean = false
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

        t.isStrict(result.exitCode, 0,
            `Subclass aggregates transitive (two-hop) registry mixin config across four files:\n${commandOutput(result)}`)
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
                    public auditField: string = ""
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
                    public timestampField: number = 0
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

        t.isStrict(result.exitCode, 0,
            `Consumer of a declaration (.d.ts) construction package aggregates transitive mixin config:\n${commandOutput(result)}`)
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
                    public auditField: string = ""
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
                    public timestampField: number = 0
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
                        public docField: boolean = false
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

        t.isStrict(result.exitCode, 0,
            `Consumer of a .d.ts construction-base mixin gets its own .new with aggregated config:\n${commandOutput(result)}`)
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
                    public appValue: string = ""
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
                        public ownValue: number = 0
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

        t.isStrict(result.exitCode, 0,
            `Subclass of a .d.ts construction base gets its own .new with aggregated config:\n${commandOutput(result)}`)
    } finally {
        await fixture.dispose()
    }
})
