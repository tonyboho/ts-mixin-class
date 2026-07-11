import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, findClass, findInterface, findVariable, typecheckText } from "./util.js"

it("keeps unrelated source files untouched", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        class SourceClass {
            value: string = "ok"
        }
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)

    t.equal(transformedFile, sourceFile, "Returns the original SourceFile instance")
})

it("does not treat a local @mixin() decorator as the package marker", async (t: Test) => {
    const sourceFile      = createSourceFile(`
        function mixin(): (..._args: unknown[]) => void {
            return () => {}
        }

        @mixin()
        class SourceClass {}
    `)
    const transformedFile = transformSourceFile(ts, sourceFile)

    t.equal(transformedFile, sourceFile, "Local decorator is ignored")
})

it("disables direct `new` on a construction mixin without its own constructor in both planes", async (t: Test) => {
    // A construction (Base-deriving) mixin with NO own constructor: a direct `new` is a type error
    // in BOTH emit and source view (the brand rides on the generated `$base`), while the static
    // `.new()` type-checks cleanly.
    const program = (tail: string): string => `
        import { mixin, Base } from "ts-mixin-class"

        @mixin()
        class Boxed extends Base {
            value: number = 0
        }
        ${tail}
    `

    for (const sourceView of [ false, true ]) {
        const plane = sourceView ? "source view" : "emit"

        const clean = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program("void Boxed.new()")), { sourceView })))
        t.is(clean.length, 0, `${plane}: .new() type-checks cleanly\n${clean.join("\n")}`)

        const banned = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program("void new Boxed()")), { sourceView })))
        t.ne(banned.length, 0, `${plane}: a direct \`new Boxed()\` is a type error`)
    }
})

it("bans `new` on a construction mixin with its own constructor in emit, keeping `super()`/`.new()` valid in both planes", async (t: Test) => {
    // A construction mixin that declares its OWN constructor: the emit value cast still bans a
    // direct `new`, while BOTH planes keep the constructor's `super()` and the static `.new()`
    // type-checking. Source view deliberately does NOT brand this case — poisoning the constructor
    // signature there would mean injecting a parameter that shifts the position-preserved body and
    // breaks navigation; the emit ban is what a build relies on.
    const program = (tail: string): string => `
        import { mixin, Base } from "ts-mixin-class"

        @mixin()
        class Tracked extends Base {
            seq: number

            constructor () {
                super()
                this.seq = 1
            }

            bump (): number {
                return ++this.seq
            }
        }
        ${tail}
    `

    for (const sourceView of [ false, true ]) {
        const plane = sourceView ? "source view" : "emit"

        const clean = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program("void Tracked.new()")), { sourceView })))
        t.is(clean.length, 0, `${plane}: the mixin's own super() and .new() type-check cleanly\n${clean.join("\n")}`)
    }

    const emitBanned = typecheckText(printSourceFile(ts, transformSourceFile(ts, createSourceFile(program("void new Tracked()")))))
    t.ne(emitBanned.length, 0, "emit: a direct `new Tracked()` is a type error")
})

it("expands an imported class-level @mixin() class into interface + factory + const", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export class SourceClass<T> {
            static staticHelper (x: number): number { return x * 2 }

            value1: string = "value1"

            passThrough1 (a: T): T { return a }

            method1 (): string { return this.value1 }
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    const interfaceDeclaration = requiredInterface(transformedFile, "SourceClass")
    const interfaceMembers     = interfaceDeclaration.members.map((member) => memberName(member))

    t.equal(findClass(transformedFile, "SourceClass"), undefined, "Original class declaration is replaced")
    t.expect(interfaceMembers).toEqual([ "value1", "passThrough1", "method1" ])
    t.equal(interfaceDeclaration.typeParameters?.length, 1, "Interface keeps the class type parameters")
    t.true(hasExportModifier(interfaceDeclaration), "Interface keeps the export modifier")

    t.not.isStrict(findVariable(transformedFile, "__SourceClass$mixin"), undefined, "Mixin factory is generated")
    t.not.isStrict(findVariable(transformedFile, "SourceClass"), undefined, "Value const is generated")

    t.notMatch(printed, "@mixin", "Marker decorator is removed")
    t.match(
        printed,
        "import { defineMixinClass as __defineMixinClass__, type AnyConstructor as __AnyConstructor__, type ClassStatics as __ClassStatics__, " +
            "type MixinApplication as __MixinApplication__, type MixinFactory as __MixinFactory__, type RuntimeMixinClass as __RuntimeMixinClass__ } from \"ts-mixin-class\"",
        "Helper import is added (pruned to the helpers this file references)"
    )
    t.match(
        printed,
        "function <T>(base: __AnyConstructor__)",
        "Factory takes a typed base"
    )
    t.match(
        printed,
        "class __SourceClass$class extends base",
        "Factory takes a base and declares the named runtime class (a DECLARATION, so legacy member decorators stay legal)"
    )
    t.match(
        printed,
        "return __SourceClass$class",
        "…and returns it by name"
    )
    t.match(printed, "static staticHelper", "Static members stay in the factory body")
    t.notMatch(printedInterface(printed), "staticHelper", "Static members are not in the interface")
    t.match(
        printed,
        "__defineMixinClass__(\"SourceClass\", __SourceClass$mixin as unknown as __MixinFactory__, []) as unknown as " +
            "(new <T>(...args: any[]) => SourceClass<T>) & " +
            "__ClassStatics__<ReturnType<typeof __SourceClass$mixin>> & {\n" +
            "    readonly mix: <T, __MixinBase extends __AnyConstructor__<any>>(base: __MixinBase) => " +
            "__MixinApplication__<__MixinBase, SourceClass<T>, ReturnType<typeof __SourceClass$mixin>>;\n" +
            "} & __RuntimeMixinClass__",
        "Value const registers the factory with the runtime helper and keeps the declarative cast"
    )
})

it("expands a named default-exported mixin class", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        export default class DefaultMixin {
            value: string = "default"

            method (): string {
                return this.value
            }
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(printed, "interface DefaultMixin", "Default mixin interface is generated")
    t.match(printed, "export const __DefaultMixin$mixin", "Default mixin factory is exported for generated imports")
    t.match(printed, "const DefaultMixin = __defineMixinClass__", "Default mixin value stays local")
    t.match(printed, "export default DefaultMixin", "Default export points at the generated runtime value")
    t.notMatch(printed, "export const DefaultMixin =", "Default mixin is not accidentally exported as a named value")
    t.expect(typecheckText(printed)).toEqual([])
})

it("supports aliased and namespace decorator imports", async (t: Test) => {
    const aliased = transformSourceFile(ts, createSourceFile(`
        import { mixin as mix } from "ts-mixin-class"

        @mix()
        class SourceClass {
            value: string = "ok"
        }
    `))

    t.not.isStrict(findInterface(aliased, "SourceClass"), undefined, "Aliased import marker expands the class")

    const namespaced = transformSourceFile(ts, createSourceFile(`
        import * as MixinClass from "ts-mixin-class"

        @MixinClass.mixin()
        class SourceClass {
            value: string = "ok"
        }
    `))

    t.not.isStrict(findInterface(namespaced, "SourceClass"), undefined, "Namespace import marker expands the class")
})

it("supports custom package and decorator options", async (t: Test) => {
    const transformedFile = transformSourceFile(
        ts,
        createSourceFile(`
        import { compose } from "custom-mixin-package"

        @compose()
        class SourceClass {
            value: string = "ok"
        }
    `),
        {
            decoratorName : "compose",
            packageName   : "custom-mixin-package"
        }
    )

    t.not.isStrict(findInterface(transformedFile, "SourceClass"), undefined, "Custom marker expands the class")
    t.match(
        printSourceFile(ts, transformedFile),
        "import { defineMixinClass as __defineMixinClass__, type AnyConstructor as __AnyConstructor__, type MixinFactory as __MixinFactory__, " +
            "type RuntimeMixinClass as __RuntimeMixinClass__, type MixinClassValue as __MixinClassValue__ } from \"custom-mixin-package\"",
        "Helper import uses the custom package name (pruned to referenced helpers)"
    )
})

it("expands a dependent mixin with a typed base and a dependency chain", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        @mixin()
        class ChildMixin<T> implements SourceClass1<T> {
            childMethod (a: T): string { return String(super.passThrough1(a)) }
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "function <T>(base: __AnyConstructor__<SourceClass1<T>> & Omit<__ClassStatics__<typeof SourceClass1>, \"mix\" | keyof __RuntimeMixinClass__>)",
        "Dependent mixin base parameter is typed with the dependency's instance AND static sides"
    )
    t.match(
        printed,
        "class __ChildMixin$class extends base",
        "Dependent mixin factory declares the named runtime class"
    )
    t.match(
        printed,
        "return __ChildMixin$class",
        "…and returns it by name"
    )
    t.match(
        printed,
        "__defineMixinClass__(\"ChildMixin\", __ChildMixin$mixin as unknown as __MixinFactory__, [SourceClass1], undefined, [[0, 0, 1]], \"verify\", undefined, 0)",
        "Value const registers the direct dependency and Empty base plan with the runtime helper"
    )
    t.match(
        printed,
        "interface ChildMixin<T> extends SourceClass1<T>",
        "Generated interface extends the dependency"
    )
})

// needed because of: https://github.com/microsoft/TypeScript/issues/63555
it("reduces transitive mixin interface heritage", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class BaseMixin {
            baseValue: string = "base"
        }

        @mixin()
        class ChildMixin implements BaseMixin {
            childValue: string = "child"
        }

        @mixin()
        class LeafMixin implements ChildMixin, BaseMixin {
            leafValue: string = "leaf"
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "interface LeafMixin extends ChildMixin",
        "Generated mixin interface keeps only the non-transitive type heritage"
    )
    t.notMatch(
        printed,
        "interface LeafMixin extends ChildMixin, BaseMixin",
        "Generated mixin interface drops transitive type heritage"
    )
    t.match(
        printed,
        "__defineMixinClass__(\"LeafMixin\", __LeafMixin$mixin as unknown as __MixinFactory__, [ChildMixin, BaseMixin], undefined, [[0, 0, 2]], \"verify\", undefined, 0)",
        "Runtime dependency metadata keeps the direct dependency list and Empty base plan"
    )
    t.expect(typecheckText(printed)).toEqual([])
})

it("keeps non-mixin implements entries on a mixin as type-only contracts", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        interface PlainContract {
            contractMethod (): string
        }

        @mixin()
        class SourceMixin implements PlainContract {
            contractMethod (): string {
                return "contract"
            }
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "interface SourceMixin extends PlainContract",
        "Generated mixin interface keeps the plain TypeScript contract"
    )
    t.match(
        printed,
        "__defineMixinClass__(\"SourceMixin\", __SourceMixin$mixin as unknown as __MixinFactory__, [])",
        "Plain contract is not registered as a runtime mixin dependency"
    )
    t.notMatch(
        printed,
        "__mixinChain__(PlainContract",
        "Plain contract is not used in the runtime chain"
    )
    t.expect(typecheckText(printed)).toEqual([])
})

it("expands a mixin required base declared with extends", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        class RequiredBase {
            requiredMethod (): string { return "required" }
        }

        @mixin()
        class RequiredMixin extends RequiredBase {
            mixinMethod (): string { return super.requiredMethod() }
        }

        class RealBase extends RequiredBase {
            override requiredMethod (): string { return "real" }
        }

        class Consumer extends RealBase implements RequiredMixin {
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "interface RequiredMixin extends RequiredBase",
        "Generated interface keeps the required base as an instance constraint"
    )
    t.match(
        printed,
        "function (base: __AnyConstructor__<RequiredBase> & __ClassStatics__<typeof RequiredBase>)",
        "Mixin factory parameter is constrained to the required base, instance AND static sides"
    )
    t.match(
        printed,
        "__defineMixinClass__(\"RequiredMixin\", __RequiredMixin$mixin as unknown as __MixinFactory__, [], RequiredBase)",
        "Value const registers the required runtime base"
    )
    t.match(
        printed,
        "class __Consumer$base<__mixinRequiredBase0 extends never>",
        "Consumer base carries a required-base constraint for diagnostics"
    )
    t.match(
        printed,
        "extends (__mixinChainLinearized__(RealBase, [RequiredMixin], [[0, 0, 1]], \"verify\")",
        "Consumer still supplies its concrete descendant base to the runtime chain"
    )
    t.match(
        printed,
        "class Consumer extends __Consumer$base<RealBase extends RequiredBase ? never :",
        "Consumer maps required-base diagnostics to the original extends heritage"
    )
    t.match(
        printed,
        "Mixin required base mismatch.",
        "Consumer required-base diagnostic carries a custom message"
    )
})

it("gives a standalone construction-base mixin its own construction `new` in the emit value cast", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Serializable extends Base {
            public format?: string = "json"
        }

        const created: Serializable = Serializable.new()
        const configured: Serializable = Serializable.new({ format: "xml" })

        void [ created, configured ]
    `)))

    t.match(
        printed,
        "export type SerializableConfig = Partial<Pick<Serializable, \"format\">>;",
        "Construction-base mixin emits a named config alias"
    )
    t.match(
        printed,
        "\"new\"(props?: SerializableConfig): Serializable;",
        "Value cast prepends a construction `new` referencing the named config alias"
    )

    t.expect(typecheckText(printed)).toEqual([])
})

it("gives a standalone construction-base mixin its own `static new` in the source view", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(
        ts,
        createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Serializable extends Base {
            public format?: string = "json"
        }
    `),
        { sourceView: true }
    ))

    t.match(
        printed,
        "export type SerializableConfig = Partial<Pick<Serializable, \"format\">>;",
        "Source-view construction-base mixin emits a named config alias"
    )
    t.match(
        printed,
        "static new(props?: SerializableConfig): Serializable;",
        "Source-view mixin class regenerates its own static new referencing the named config alias"
    )
    // The navigable mixin heritage: the class re-extends the real `Base` under the
    // branded single-source cast (no `__Serializable$base` pair), so the static new
    // attaches to the real class AND the base name stays navigable.
    t.match(
        printed,
        "class Serializable extends (Base as unknown as",
        "Source view keeps the mixin as a real class extending the navigable cast"
    )
    t.match(
        printed,
        "use_the_static_new_factory",
        "The direct-`new` construction brand rides inside the cast"
    )
})

it("collects the transitive mixin chain into a construction-base mixin's `new` config", async (t: Test) => {
    // Regression: a @mixin class collects construction config only from its direct
    // `implements` refs, not the transitive chain those refs pull in. So `Leaf`,
    // which implements `Middle` which implements `Deep`, dropped `Deep`'s public
    // `deepValue` from `Leaf.new(...)` — `Leaf.new({ deepValue })` then failed with
    // "Object literal may only specify known properties". (The consumer path
    // linearizes and does not have this bug; only the mixin construction path did.)
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        class Deep extends Base {
            public deepValue?: number = 0
        }

        @mixin()
        class Middle extends Base implements Deep {}

        @mixin()
        class Leaf extends Base implements Middle {
            public ownValue?: string = ""
        }

        const leaf: Leaf = Leaf.new({ deepValue: 1, ownValue: "x" })

        void leaf
    `)))

    t.match(
        printed,
        // Key order is NEAREST-first (§7.29): own members lead, the dependency chain trails.
        "Pick<Leaf, \"ownValue\" | \"deepValue\">",
        "Mixin construction config includes the transitive mixin-chain public property"
    )
    t.expect(typecheckText(printed)).toEqual([])
})

it("does not throw transforming a mixin while the `extends` keyword is being typed", async (t: Test) => {
    // Regression: typing `extends` into a @mixin class goes through a transient
    // syntax-error state (`class X extends {` — the body brace is parsed as an
    // object-literal base). Incremental re-parsing leaves that malformed heritage
    // node with an undeterminable source file, so deep-cloning it threw
    // "Could not determine parsed source file". In tsserver that exception crashed
    // the whole program transform, falling back to the untransformed program — so
    // unrelated construction-base classes lost their generated `new`, and the
    // broken state stuck (structureIsReused: Completely) until a server restart.
    let sourceFile = createSourceFile("typing.ts", `
        import { mixin } from "ts-mixin-class"

        @mixin()
        class Typed {
            value: number = 0
        }
    `)

    transformSourceFile(ts, sourceFile, { sourceView: true })

    // Type " extends" one character at a time after the class name, re-parsing
    // incrementally (ts.updateSourceFile) exactly as tsserver does on each keystroke.
    let text     = sourceFile.text
    let position = text.indexOf("class Typed") + "class Typed".length

    for (const character of " extends") {
        const nextText = text.slice(0, position) + character + text.slice(position)

        sourceFile = ts.updateSourceFile(
            sourceFile,
            nextText,
            ts.createTextChangeRange(ts.createTextSpan(position, 0), character.length)
        )
        text       = nextText
        position++

        t.doesNotThrow(
            () => transformSourceFile(ts, sourceFile, { sourceView: true }),
            `Transforming after typing ${JSON.stringify(character)} does not throw`
        )
    }
})

function requiredInterface(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration {
    const declaration = findInterface(sourceFile, name)

    if (declaration === undefined) {
        throw new Error(`Cannot find interface ${name}`)
    }

    return declaration
}

function memberName(member: ts.TypeElement): string {
    if (member.name !== undefined && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) {
        return member.name.text
    }

    throw new Error("Unexpected interface member name")
}

function hasExportModifier(node: ts.InterfaceDeclaration): boolean {
    return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
}

function printedInterface(printed: string): string {
    const start = printed.indexOf("interface ")
    const end   = printed.indexOf("}", start)

    return printed.slice(start, end + 1)
}

// The whole transformed MIXIN output must COMPILE (moved here from the consumer
// typecheck file: the subject is the mixin declaration itself).
it("transformed mixin output typechecks, including generics, statics and super calls", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { base, factory, mixin, requirements } from "ts-mixin-class"

        @mixin()
        export class SourceClass1<T> {
            static staticHelper (x: number): number { return x * 2 }

            value1: string = "value1"

            passThrough1 (a: T): T { return a }

            method1 (): string { return this.value1 }

            makeAnother (): SourceClass1<number> {
                return new SourceClass1<number>()
            }
        }

        @mixin()
        export class ChildMixin<T> implements SourceClass1<T> {
            childMethod (a: T): string {
                return "child/" + String(super.passThrough1(a)) + "/" + super.method1()
            }
        }

        const direct = new SourceClass1<number>()

        const v1: number = direct.passThrough1(3)
        const v2: number = SourceClass1.staticHelper(2)
        const v3: SourceClass1<number> = direct.makeAnother()
        const v4 = SourceClass1[factory]
        const v5 = SourceClass1[requirements]
        const v6 = SourceClass1[base]

        // @ts-expect-error дженерик T = number, строка не подходит
        const e1: number = direct.passThrough1("x")

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e2 = SourceClass1.$mixin

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e3 = SourceClass1.$requirements

        // @ts-expect-error runtime metadata is exposed through symbols, not string API members.
        const e4 = SourceClass1.$requiredBase

        const child = new ChildMixin<boolean>()

        const v7: string = child.childMethod(true)
        const v8: boolean = child.passThrough1(false)

        // @ts-expect-error childMethod принимает T = boolean
        const e5: string = child.childMethod("x")

        void [v1, v2, v3, v4, v5, v6, v7, v8, e1, e2, e3, e4, e5]
    `))

    const diagnostics = typecheckText(printSourceFile(ts, transformedFile))

    t.expect(diagnostics).toEqual([])
})
