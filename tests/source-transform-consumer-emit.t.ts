import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile } from "./util.js"

it("expands a consumer class into a merged intermediate base", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        @mixin()
        class SourceClass2<A> {
            passThrough2 (a: A): A { return a }
        }

        class Base {
            baseValue: number = 42
        }

        class Consumer<A> extends Base implements SourceClass1<string>, SourceClass2<A> {
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "interface __Consumer$base<A> extends SourceClass1<string>, SourceClass2<A>",
        "Merged interface repeats the implements list verbatim"
    )
    t.match(
        printed,
        "class __Consumer$base<A> extends (__mixinChainLinearized__(Base, [SourceClass1, SourceClass2], [[0, 0, 1], [1, 0, 1]], \"verify\") as unknown as " +
            "typeof Base & Omit<typeof SourceClass1, \"prototype\" | \"new\" | \"mix\"> & Omit<typeof SourceClass2, \"prototype\" | \"new\" | \"mix\">)",
        "Intermediate base delegates the runtime chain to the helper with the statics cast"
    )
    t.match(
        printed,
        "class Consumer<A> extends __Consumer$base<A> implements SourceClass1<string>, SourceClass2<A>",
        "Consumer extends the intermediate base and keeps its implements clause"
    )
})

it("expands a consumer class without an explicit base", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        class Consumer<T> implements SourceClass1<T> {
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "class __Consumer$empty {\n}",
        "An explicit empty base class is generated"
    )
    t.match(
        printed,
        "class __Consumer$base<T> extends (__mixinChainLinearized__(__Consumer$empty, [SourceClass1], [[0, 0, 1]], \"verify\") as unknown as " +
            "typeof __Consumer$empty & Omit<typeof SourceClass1, \"prototype\" | \"new\" | \"mix\">)",
        "Helper chain starts at the generated empty base and keeps mixin statics"
    )
    t.notMatch(
        printed,
        "__mixinChainLinearized__(Object, [SourceClass1]",
        "Helper chain does not use Object as the implicit consumer base"
    )
})

it("adds a synthetic super call to consumer constructors without an explicit base", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass<T> {
            passThrough (a: T): T { return a }
        }

        class Consumer<T> implements SourceClass<T> {
            value: T

            constructor (value: T) {
                this.value = value
            }
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "constructor(value: T) {\n        super();\n        this.value = value;\n    }",
        "Consumer constructor gets a leading synthetic super call"
    )
})

it("emits a generic consumer base class", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        class Base<T> {
            baseValue: T

            constructor (baseValue: T) {
                this.baseValue = baseValue
            }

            baseMethod (): T {
                return this.baseValue
            }
        }

        class Consumer<A> extends Base<A> implements SourceClass1<string> {
            method (): A {
                return super.baseMethod()
            }
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "interface __Consumer$base<A> extends Base<A>, SourceClass1<string>",
        "Merged interface includes the instantiated generic base"
    )
})

it("consumer transitively applies mixin dependencies", async (t: Test) => {
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

        class Consumer<T> implements ChildMixin<T> {
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "__mixinChainLinearized__(__Consumer$empty, [ChildMixin], [[0, 0, 2]], \"verify\")",
        "Consumer delegates transitive dependency application to the runtime helper"
    )
    t.match(
        printed,
        "interface __Consumer$base<T> extends ChildMixin<T>",
        "Merged interface lists only the direct implements entries"
    )
})

it("does not treat non-mixin implements entries as mixins", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class SourceClass1<T> {
            passThrough1 (a: T): T { return a }
        }

        interface PlainContract {
            contractMethod (): void
        }

        class Consumer<T> implements SourceClass1<T>, PlainContract {
            contractMethod (): void {}
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "interface __Consumer$base<T> extends SourceClass1<T> {",
        "Merged interface contains only mixin entries"
    )
    t.match(
        printed,
        "implements SourceClass1<T>, PlainContract",
        "Consumer keeps the full implements list"
    )
})

it("generates public-only static construction config overloads by default", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class GenericBase<T> extends Base {
            public baseValue!: T | undefined
            public optionalBaseValue?: T
            skippedBaseValue: T | undefined
        }

        @mixin()
        class SourceClass<T> {
            public mixinValue!: T | undefined
            public optionalMixinValue?: T
            skippedMixinValue: T | undefined
            mixinMethod (): T | undefined { return this.mixinValue }
        }

        export class Consumer<T> extends GenericBase<T> implements SourceClass<T> {
            public ownValue!: T | undefined
            public optionalOwnValue?: T
            skippedOwnValue: T | undefined
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "export type ConsumerConfig<T> = {",
        "Default public-only construction config emits a flattened named alias"
    )
    t.match(
        printed,
        "Pick<Consumer<T>, \"baseValue\" | \"mixinValue\" | \"ownValue\"> & " +
            "Partial<Pick<Consumer<T>, \"optionalBaseValue\" | \"optionalMixinValue\" | \"optionalOwnValue\">>",
        "Default public-only construction config preserves required and optional property names in the named alias"
    )
    t.match(
        printed,
        "static new<T>(props: ConsumerConfig<T>): Consumer<T>;",
        "The generated static new references the named config alias"
    )
    t.notMatch(
        printed,
        "\"mixinMethod\"",
        "Generated construction config does not include methods"
    )
    t.notMatch(
        printed,
        "\"skippedBaseValue\"",
        "Public-only construction config ignores base fields without an explicit public modifier"
    )
    t.notMatch(
        printed,
        "\"skippedMixinValue\"",
        "Public-only construction config ignores mixin fields without an explicit public modifier"
    )
    t.notMatch(
        printed,
        "\"skippedOwnValue\"",
        "Public-only construction config ignores consumer fields without an explicit public modifier"
    )
})

it("generates public-only static construction config overloads for plain Base descendants", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        export class Model extends Base {
            public id!: string = ""
            public name?: string = ""
            skippedValue: string = ""
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "Pick<Model, \"id\"> & Partial<Pick<Model, \"name\">>",
        "Plain Base descendants get required and optional public-only config fields in the named alias"
    )
    t.match(
        printed,
        "static new(props: ModelConfig): Model;",
        "Plain Base descendant static new references the named config alias"
    )
    t.notMatch(
        printed,
        "\"skippedValue\"",
        "Plain Base public-only config ignores fields without an explicit public modifier"
    )
})

it("generates construction members for transitive same-file Base descendants", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class GrandBase extends Base {
            public g!: string = ""
        }

        class Mid extends GrandBase {
            public m!: number = 0
        }

        class Leaf extends Mid {
            public l!: boolean = false
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "): GrandBase;",
        "A direct Base descendant gets its own static new"
    )
    t.match(
        printed,
        "): Mid;",
        "An intermediate descendant regenerates static new through the local extends chain"
    )
    t.match(
        printed,
        "): Leaf;",
        "A transitive descendant regenerates static new with its own instance type"
    )
})

it("emits undefined non-null initializers for construction fields of every visibility", async (t: Test) => {
    const transformedFile = transformSourceFile(
        ts,
        createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class ShapeBase extends Base {
            public baseValue!: number
        }

        @mixin()
        class ShapeMixin {
            public mixinValue!: string
        }

        class ShapeConsumer extends ShapeBase implements ShapeMixin {
            public ownValue!: boolean
            skippedValue: number
        }
    `),
        {
            fillMissedInitializersWith : "undefined"
        }
    )
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "public baseValue: number = undefined!",
        "Base public-only config field gets a local undefined non-null initializer"
    )
    t.match(
        printed,
        "public mixinValue: string = undefined!",
        "Mixin public-only config field gets a local undefined non-null initializer"
    )
    t.match(
        printed,
        "public ownValue: boolean = undefined!",
        "Consumer public-only config field gets a local undefined non-null initializer"
    )
    t.match(
        printed,
        "skippedValue: number = undefined!",
        "A non-public field is filled too (fill is visibility-independent)"
    )
    t.notMatch(
        printed,
        "number | undefined",
        "Declared property types are not widened"
    )
})

it("can emit undefined non-null initializers for plain Base descendants without helper imports", async (t: Test) => {
    const transformedFile = transformSourceFile(
        ts,
        createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class PlainShape extends Base {
            public value!: number
        }
    `),
        {
            fillMissedInitializersWith : "undefined"
        }
    )
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "public value: number = undefined!",
        "Plain Base descendant required property gets a local undefined non-null initializer"
    )
    t.notMatch(
        printed,
        "defineMixinClass",
        "Plain Base descendant rewrite does not add mixin helper imports"
    )
    t.notMatch(
        printed,
        "mixinChain",
        "Plain Base descendant rewrite does not add consumer helper imports"
    )
})

it("fills with null non-null initializers under fillMissedInitializersWith \"null\"", async (t: Test) => {
    const transformedFile = transformSourceFile(
        ts,
        createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class ShapeBase extends Base {
            public baseValue!: number
            protected protectedValue: number
        }

        @mixin()
        class ShapeMixin {
            public mixinValue!: string
        }

        class ShapeConsumer extends ShapeBase implements ShapeMixin {
            public ownValue!: boolean
        }
    `),
        {
            fillMissedInitializersWith : "null"
        }
    )
    const printed         = printSourceFile(ts, transformedFile)

    t.match(printed, "public baseValue: number = null!", "A public field is filled with `null!` in null mode")
    t.match(printed, "protectedValue: number = null!", "A protected field is filled with `null!` in null mode")
    t.match(printed, "public mixinValue: string = null!", "A mixin field is filled with `null!` in null mode")
    t.match(printed, "public ownValue: boolean = null!", "A consumer field is filled with `null!` in null mode")
    t.notMatch(printed, "= undefined!", "null mode never fills with undefined")
    t.notMatch(printed, "number | null", "Declared property types are not widened in null mode")
})

it("fills nothing under fillMissedInitializersWith \"nothing\"", async (t: Test) => {
    const transformedFile = transformSourceFile(
        ts,
        createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class ShapeBase extends Base {
            public baseValue!: number
        }
    `),
        {
            fillMissedInitializersWith : "nothing"
        }
    )
    const printed         = printSourceFile(ts, transformedFile)

    // "nothing" leaves the field untouched: no synthetic initializer, the `!` survives.
    t.match(printed, "public baseValue!: number;", "nothing mode leaves the `!` field with no initializer")
    t.notMatch(printed, "= undefined!", "nothing mode adds no undefined fill")
    t.notMatch(printed, "= null!", "nothing mode adds no null fill")
})
