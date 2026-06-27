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
        "import { defineMixinClass, type AnyConstructor, type ClassStatics, " +
            "type MixinApplication, type MixinFactory, type RuntimeMixinClass } from \"ts-mixin-class\"",
        "Helper import is added (pruned to the helpers this file references)"
    )
    t.match(printed, "function <T>(base: AnyConstructor)",
        "Factory takes a typed base")
    t.match(printed, "return class extends base",
        "Factory takes a base and returns an anonymous class expression")
    t.match(printed, "static staticHelper", "Static members stay in the factory body")
    t.notMatch(printedInterface(printed), "staticHelper", "Static members are not in the interface")
    t.match(
        printed,
        "defineMixinClass(\"SourceClass\", __SourceClass$mixin as unknown as MixinFactory, []) as unknown as " +
            "(new <T>(...args: any[]) => SourceClass<T>) & " +
            "ClassStatics<ReturnType<typeof __SourceClass$mixin>> & {\n" +
            "    readonly mix: <T, __MixinBase extends AnyConstructor<any>>(base: __MixinBase) => " +
            "MixinApplication<__MixinBase, SourceClass<T>, ReturnType<typeof __SourceClass$mixin>>;\n" +
            "} & RuntimeMixinClass",
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
    t.match(printed, "const DefaultMixin = defineMixinClass", "Default mixin value stays local")
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
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { compose } from "custom-mixin-package"

        @compose()
        class SourceClass {
            value: string = "ok"
        }
    `), {
        decoratorName : "compose",
        packageName   : "custom-mixin-package"
    })

    t.not.isStrict(findInterface(transformedFile, "SourceClass"), undefined, "Custom marker expands the class")
    t.match(
        printSourceFile(ts, transformedFile),
        "import { defineMixinClass, type AnyConstructor, type MixinFactory, " +
            "type RuntimeMixinClass, type MixinClassValue } from \"custom-mixin-package\"",
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

    t.match(printed, "function <T>(base: AnyConstructor<SourceClass1<T>>)",
        "Dependent mixin base parameter is typed with the dependency")
    t.match(printed, "return class extends base",
        "Dependent mixin factory returns an anonymous class expression")
    t.match(printed, "defineMixinClass(\"ChildMixin\", __ChildMixin$mixin as unknown as MixinFactory, [SourceClass1], undefined, [[0, 0, 1]], \"verify\")",
        "Value const registers the direct dependency with the runtime helper")
    t.match(printed, "interface ChildMixin<T> extends SourceClass1<T>",
        "Generated interface extends the dependency")
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

    t.match(printed, "interface LeafMixin extends ChildMixin",
        "Generated mixin interface keeps only the non-transitive type heritage")
    t.notMatch(printed, "interface LeafMixin extends ChildMixin, BaseMixin",
        "Generated mixin interface drops transitive type heritage")
    t.match(printed, "defineMixinClass(\"LeafMixin\", __LeafMixin$mixin as unknown as MixinFactory, [ChildMixin, BaseMixin], undefined, [[0, 0, 2]], \"verify\")",
        "Runtime dependency metadata keeps the direct dependency list")
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

    t.match(printed, "interface SourceMixin extends PlainContract",
        "Generated mixin interface keeps the plain TypeScript contract")
    t.match(printed, "defineMixinClass(\"SourceMixin\", __SourceMixin$mixin as unknown as MixinFactory, [])",
        "Plain contract is not registered as a runtime mixin dependency")
    t.notMatch(printed, "mixinChain(PlainContract",
        "Plain contract is not used in the runtime chain")
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

    t.match(printed, "interface RequiredMixin extends RequiredBase",
        "Generated interface keeps the required base as an instance constraint")
    t.match(printed, "function (base: AnyConstructor<RequiredBase>)",
        "Mixin factory parameter is constrained to the required base")
    t.match(printed, "defineMixinClass(\"RequiredMixin\", __RequiredMixin$mixin as unknown as MixinFactory, [], RequiredBase)",
        "Value const registers the required runtime base")
    t.match(printed, "class __Consumer$base<__mixinRequiredBase0 extends never>",
        "Consumer base carries a required-base constraint for diagnostics")
    t.match(printed, "extends (mixinChainLinearized(RealBase, [RequiredMixin], [[0, 0, 1]], \"verify\")",
        "Consumer still supplies its concrete descendant base to the runtime chain")
    t.match(printed, "class Consumer extends __Consumer$base<RealBase extends RequiredBase ? never :",
        "Consumer maps required-base diagnostics to the original extends heritage")
    t.match(printed, "Mixin required base mismatch.",
        "Consumer required-base diagnostic carries a custom message")
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

    t.match(printed, "export type SerializableConfig = Partial<Pick<Serializable, \"format\">>;",
        "Construction-base mixin emits a named config alias")
    t.match(printed, "\"new\"(props?: SerializableConfig): Serializable;",
        "Value cast prepends a construction `new` referencing the named config alias")

    t.expect(typecheckText(printed)).toEqual([])
})

it("gives a standalone construction-base mixin its own `static new` in the source view", async (t: Test) => {
    const printed = printSourceFile(ts, transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        @mixin()
        export class Serializable extends Base {
            public format?: string = "json"
        }
    `), { sourceView: true }))

    t.match(printed, "export type SerializableConfig = Partial<Pick<Serializable, \"format\">>;",
        "Source-view construction-base mixin emits a named config alias for user `initialize` references")
    // Source view INLINES the structural config into the generated `static new` param rather
    // than referencing `SerializableConfig`: the synthetic alias name renders as a meaningless
    // `}` in a failing `.new(...)` diagnostic (its name node has no real source text to read),
    // so the inline `Pick<...>` keeps the editor diagnostic readable. Emit keeps the alias name.
    t.match(printed, "static new(props?: Partial<Pick<Serializable, \"format\">>): Serializable;",
        "Source-view mixin's static new inlines the structural config so the editor diagnostic stays readable")
    t.notMatch(printed, "static new(props?: SerializableConfig)",
        "Source-view static new does NOT reference the alias by name (it would display as `}`)")
    t.match(printed, "class Serializable extends __Serializable$base",
        "Source view keeps the mixin as a real class so the static new can attach")
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

    t.match(printed, "Pick<Leaf, \"deepValue\" | \"ownValue\">",
        "Mixin construction config includes the transitive mixin-chain public property")
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
