import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

// The generated construction config is exposed as an exported, named type alias
// `<ClassName>Config` (carrying the class's own type parameters) rather than an
// inline `Pick<...>`. This (1) makes `.new(...)` type errors read the clean alias
// name instead of a verbose `Pick<...>` union, and (2) lets users type an
// `initialize` override with the exact strict config: `initialize(config?: ModelConfig)`.

it("emits an exported named config alias and references it from the generated static new", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id: string = ""
            public name?: string = ""
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "export type ModelConfig = Pick<Model, \"id\"> & Partial<Pick<Model, \"name\">>;",
        "A construction base emits an exported config alias named after the class"
    )
    t.match(
        printed,
        "static new(props: ModelConfig): Model;",
        "The generated static new references the alias instead of an inline Pick"
    )
})

it("emits a generic config alias carrying the class type parameters", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class GenericBase<T> extends Base {
            public baseValue: T | undefined
            public optionalBaseValue?: T
        }

        @mixin()
        class SourceClass<T> {
            public mixinValue: T | undefined
        }

        class Consumer<T> extends GenericBase<T> implements SourceClass<T> {
            public ownValue: T | undefined
        }
    `))
    const printed = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "export type ConsumerConfig<T> = Pick<Consumer<T>, \"baseValue\" | \"mixinValue\" | \"ownValue\"> & " +
            "Partial<Pick<Consumer<T>, \"optionalBaseValue\">>;",
        "The config alias clones the class type parameters and references the consumer instance type"
    )
    t.match(
        printed,
        "static new<T>(props: ConsumerConfig<T>): Consumer<T>;",
        "The generic static new references the generic config alias with the class type parameters"
    )
})

it("names the config alias in `.new(...)` type errors instead of an inline Pick", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id: string = ""
            public role: string = ""
        }

        Model.new({ id : "x" })
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.match(messages, "ModelConfig", "The type error names the generated config alias")
    // An all-required config is a single `Pick`, which carries the alias symbol, so
    // both the `parameter of type` and the `required in type` parts read the alias.
    t.notMatch(messages, "Pick<Model", "The type error does not spell out the inline Pick union")
})

it("exports the config alias for reuse as a factory parameter or annotation", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id: string = ""
            public name?: string = ""
        }

        function makeModel(config: ModelConfig): Model {
            return Model.new(config)
        }

        const created = makeModel({ id : "a" })
        const literal: ModelConfig = { id : "b", name : "n" }
        void [ created, literal ]
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "The exported alias is usable as a factory parameter and a variable annotation")
})

it("rejects a missing required field when the alias is used as a factory parameter", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id: string = ""
        }

        const bad: ModelConfig = {}
        void bad
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.match(messages, "ModelConfig", "A missing required field is reported against the named alias")
})

it("lets a consumer type its initialize override with the strict config alias", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id: string = ""
            public name?: string = ""

            override initialize(config: ModelConfig): void {
                super.initialize(config)
                this.name = config.name ?? config.id
            }
        }

        const created = Model.new({ id : "a" })
        void created
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "A strict-required initialize override typed with the alias produces no diagnostics")
})

it("keeps the initialize override body strictly typed against the config alias", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id: string = ""

            override initialize(config: ModelConfig): void {
                super.initialize(config)
                void config.nope
            }
        }

        void Model
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.match(messages, "nope", "An unknown field inside the override body is still rejected")
})

it("lets a mixin type its initialize override with its own config alias and a consumer apply several such mixins", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class A extends Base {
            public a: string = ""

            override initialize(config: AConfig): void {
                super.initialize(config)
                this.a = config.a
            }
        }

        @mixin()
        class B extends Base {
            public b: number = 0

            override initialize(config: BConfig): void {
                super.initialize(config)
                this.b = config.b
            }
        }

        class C extends Base implements A, B {
            public c: boolean = false
        }

        const created = C.new({ a : "x", b : 1, c : true })
        void created
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    // Both mixins override initialize with their own strict config; the consumer's
    // generated base interface re-declares the Base.initialize protocol member, so the
    // merge no longer fails with TS2320 ("not identical").
    t.is(messages, "", "A consumer of several mixins that override initialize with their own config typechecks")
})

it("supports an initialize override through a mixin dependency chain", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class Identified extends Base {
            public id: string = ""

            override initialize(config: IdentifiedConfig): void {
                super.initialize(config)
                this.id = config.id
            }
        }

        // A mixin that depends on another construction mixin (which extends Base) and also
        // overrides initialize. It reuses the dependency's config alias for the slice it
        // reads; the consumer below merges the whole chain.
        @mixin()
        class Audited implements Identified {
            public audited: boolean = false

            override initialize(config: IdentifiedConfig): void {
                super.initialize(config)
            }
        }

        class Record extends Base implements Audited {
            public name: string = ""

            override initialize(config: RecordConfig): void {
                super.initialize(config)
            }
        }

        const created = Record.new({ id : "r1", audited : true, name : "n" })
        void created
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "A consumer of a mixin chain whose members override initialize typechecks")
})

it("keeps a mixin's initialize override body strictly typed against its own config alias", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class A extends Base {
            public a: string = ""

            override initialize(config: AConfig): void {
                super.initialize(config)
                void config.nope
            }
        }

        void A
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.match(messages, "nope", "An unknown field inside the mixin override body is still rejected")
})

it("still surfaces a genuine initialize clash for a non-construction consumer of plain mixins", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"

        @mixin()
        class A {
            initialize(value: string): void { void value }
        }

        @mixin()
        class B {
            initialize(value: number): void { void value }
        }

        class C implements A, B {
        }

        void (null as unknown as C)
    `))
    const messages = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    // No package Base, so this is NOT a construction consumer: the protocol member is
    // not injected and a real, user-meaningful initialize conflict is not masked.
    t.match(messages, "TS2320", "A non-construction consumer of clashing plain initialize methods still reports TS2320")
})

it("falls back to a suffixed alias name when the class name is already taken", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        type ModelConfig = { custom : string }

        class Model extends Base {
            public id: string = ""
        }

        const user: ModelConfig = { custom : "x" }
        void user
    `))
    const printed  = printSourceFile(ts, transformedFile)
    const messages = typecheckText(printed).join("\n")

    t.match(printed, "export type ModelConfig_ =", "Collision with a user type appends an underscore")
    t.match(printed, "static new(props: ModelConfig_): Model;", "The static new references the suffixed alias")
    t.notMatch(messages, "TS2300", "The generated alias does not duplicate the user's identifier")
})
