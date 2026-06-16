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
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "interface __Consumer$base<A> extends SourceClass1<string>, SourceClass2<A>",
        "Merged interface repeats the implements list verbatim")
    t.match(
        printed,
        "class __Consumer$base<A> extends (mixinChain(Base, SourceClass1, SourceClass2) as unknown as " +
            "typeof Base & ClassStatics<typeof SourceClass1> & ClassStatics<typeof SourceClass2>)",
        "Intermediate base delegates the runtime chain to the helper with the statics cast"
    )
    t.match(printed, "class Consumer<A> extends __Consumer$base<A> implements SourceClass1<string>, SourceClass2<A>",
        "Consumer extends the intermediate base and keeps its implements clause")
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
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "class __Consumer$empty {\n}",
        "An explicit empty base class is generated")
    t.match(
        printed,
        "class __Consumer$base<T> extends (mixinChain(__Consumer$empty, SourceClass1) as unknown as " +
            "typeof __Consumer$empty & ClassStatics<typeof SourceClass1>)",
        "Helper chain starts at the generated empty base and keeps mixin statics"
    )
    t.notMatch(printed, "mixinChain(Object, SourceClass1)",
        "Helper chain does not use Object as the implicit consumer base")
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
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "constructor(value: T) {\n        super();\n        this.value = value;\n    }",
        "Consumer constructor gets a leading synthetic super call")
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
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "interface __Consumer$base<A> extends Base<A>, SourceClass1<string>",
        "Merged interface includes the instantiated generic base")
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
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "mixinChain(__Consumer$empty, ChildMixin)",
        "Consumer delegates transitive dependency application to the runtime helper")
    t.match(printed, "interface __Consumer$base<T> extends ChildMixin<T>",
        "Merged interface lists only the direct implements entries")
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
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "interface __Consumer$base<T> extends SourceClass1<T> {",
        "Merged interface contains only mixin entries")
    t.match(printed, "implements SourceClass1<T>, PlainContract",
        "Consumer keeps the full implements list")
})

it("generates public-only static construction config overloads by default", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class GenericBase<T> extends Base {
            public baseValue: T | undefined
            public optionalBaseValue?: T
            skippedBaseValue: T | undefined
        }

        @mixin()
        class SourceClass<T> {
            public mixinValue: T | undefined
            public optionalMixinValue?: T
            skippedMixinValue: T | undefined
            mixinMethod (): T | undefined { return this.mixinValue }
        }

        class Consumer<T> extends GenericBase<T> implements SourceClass<T> {
            public ownValue: T | undefined
            public optionalOwnValue?: T
            skippedOwnValue: T | undefined
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "static new<T>(props?: Pick<Consumer<T>, \"baseValue\" | \"mixinValue\" | \"ownValue\"> & " +
            "Partial<Pick<Consumer<T>, \"optionalBaseValue\" | \"optionalMixinValue\" | \"optionalOwnValue\">>): Consumer<T>;",
        "Default public-only construction config preserves required and optional property names"
    )
    t.notMatch(printed, "\"mixinMethod\"",
        "Generated construction config does not include methods")
    t.notMatch(printed, "\"skippedBaseValue\"",
        "Public-only construction config ignores base fields without an explicit public modifier")
    t.notMatch(printed, "\"skippedMixinValue\"",
        "Public-only construction config ignores mixin fields without an explicit public modifier")
    t.notMatch(printed, "\"skippedOwnValue\"",
        "Public-only construction config ignores consumer fields without an explicit public modifier")
})

it("can use instance-type construction config mode", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class GenericBase<T> extends Base {
            baseValue: T | undefined
        }

        @mixin()
        class SourceClass<T> {
            mixinValue: T | undefined
        }

        class Consumer<T> extends GenericBase<T> implements SourceClass<T> {
            ownValue: T | undefined
        }
    `), {
        constructionConfig : "instance-type"
    })
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "static new<T>(props?: Partial<Consumer<T>>): Consumer<T>;",
        "Instance-type construction config mode uses the whole consumer instance shape")
    t.notMatch(printed, "Pick<Consumer<T>",
        "Instance-type construction config mode skips static public-property collection")
})

it("can emit undefined non-null initializers for public-only construction config fields", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class ShapeBase extends Base {
            public baseValue: number = undefined
        }

        @mixin()
        class ShapeMixin {
            public mixinValue: string = undefined
        }

        class ShapeConsumer extends ShapeBase implements ShapeMixin {
            public ownValue: boolean = undefined
            skippedValue: number = undefined
        }
    `), {
        allowUndefinedForRequiredProperties : true
    })
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "public baseValue: number = undefined!",
        "Base public-only config field gets a local undefined non-null initializer")
    t.match(printed, "public mixinValue: string = undefined!",
        "Mixin public-only config field gets a local undefined non-null initializer")
    t.match(printed, "public ownValue: boolean = undefined!",
        "Consumer public-only config field gets a local undefined non-null initializer")
    t.match(printed, "skippedValue: number = undefined",
        "Non-public field keeps the original strict initializer")
    t.notMatch(printed, "number | undefined",
        "Declared property types are not widened")
})

it("can emit undefined non-null initializers for plain Base descendants without helper imports", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class PlainShape extends Base {
            public value: number = undefined
        }
    `), {
        allowUndefinedForRequiredProperties : true
    })
    const printed = printSourceFile(ts, transformedFile)

    t.match(printed, "public value: number = undefined!",
        "Plain Base descendant required property gets a local undefined non-null initializer")
    t.notMatch(printed, "defineMixinClass",
        "Plain Base descendant rewrite does not add mixin helper imports")
    t.notMatch(printed, "mixinChain",
        "Plain Base descendant rewrite does not add consumer helper imports")
})
