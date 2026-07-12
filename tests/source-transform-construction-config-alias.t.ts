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

        export class Model extends Base {
            public id!: string = ""
            public name?: string = ""
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    // The required+optional config is flattened through a homomorphic mapped type (so a failing
    // `.new(...)` names the alias, not an inner `Pick`); the constituent keys still appear inside.
    t.match(
        printed,
        "export type ModelConfig = {",
        "A construction base emits an exported config alias named after the class"
    )
    t.match(
        printed,
        "Pick<Model, \"id\"> & Partial<Pick<Model, \"name\">>",
        "The alias keeps the required `id` and optional `name` constituents"
    )
    t.match(
        printed,
        "static new(props: ModelConfig): Model;",
        "The generated static new references the alias instead of an inline Pick"
    )
})

it("marks required config keys with `!` and lets a `!` field keep an initializer", async (t: Test) => {
    // The required/optional split is driven by the definite-assignment `!`: `id!` is a required
    // config key, the unmarked `label` is optional. A `!` field may also carry an initializer
    // (a default); TypeScript forbids `!` + initializer (TS1263), so the transformer strips the
    // `!` from the emitted property, leaving a clean `id: string = "anon"` — and never widens it.
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        export class Model extends Base {
            public id!: string = "anon"
            public label: string = ""
        }

        const created = Model.new({ id : "x" })
        const id: string = created.id
        void [ created, id ]
    `))
    const printed         = printSourceFile(ts, transformedFile)
    const messages        = typecheckText(printed).join("\n")

    t.is(messages, "", "A `!` field with an initializer compiles (no TS1263) and `.new` only requires it")
    t.match(
        printed,
        "Pick<Model, \"id\"> & Partial<Pick<Model, \"label\">>",
        "`!` makes `id` a required key; the unmarked `label` is an optional key"
    )
    t.match(printed, "id: string = \"anon\"", "The emitted `!` field keeps its default and drops the now-illegal `!`")
    t.notMatch(printed, "id!: string", "The definite-assignment `!` is stripped from the emitted property")
})

it("emits a generic config alias carrying the class type parameters", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base, mixin } from "ts-mixin-class"

        class GenericBase<T> extends Base {
            public baseValue!: T | undefined
            public optionalBaseValue?: T
        }

        @mixin()
        class SourceClass<T> {
            public mixinValue!: T | undefined
        }

        export class Consumer<T> extends GenericBase<T> implements SourceClass<T> {
            public ownValue!: T | undefined
        }
    `))
    const printed         = printSourceFile(ts, transformedFile)

    t.match(
        printed,
        "export type ConsumerConfig<T> = {",
        "The config alias clones the class type parameters into a flattened named alias"
    )
    t.match(
        printed,
        // Key order is NEAREST-first (§7.29): own, then mixins, then the base chain.
        "Pick<Consumer<T>, \"ownValue\" | \"mixinValue\" | \"baseValue\"> & " +
            "Partial<Pick<Consumer<T>, \"optionalBaseValue\">>",
        "The generic alias references the consumer instance type with required and optional keys"
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
            public id!: string = ""
            public role!: string = ""
        }

        Model.new({ id : "x" })
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.match(messages, "ModelConfig", "The type error names the generated config alias")
    // An all-required config is a single `Pick`, which carries the alias symbol, so
    // both the `parameter of type` and the `required in type` parts read the alias.
    t.notMatch(messages, "Pick<Model", "The type error does not spell out the inline Pick union")
})

it("exports the config alias for reuse as a factory parameter or annotation", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id!: string = ""
            public name?: string = ""
        }

        function makeModel(config: ModelConfig): Model {
            return Model.new(config)
        }

        const created = makeModel({ id : "a" })
        const literal: ModelConfig = { id : "b", name : "n" }
        void [ created, literal ]
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "The exported alias is usable as a factory parameter and a variable annotation")
})

it("rejects a missing required field when the alias is used as a factory parameter", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id!: string = ""
        }

        const bad: ModelConfig = {}
        void bad
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.match(messages, "ModelConfig", "A missing required field is reported against the named alias")
})

// The `<ClassName>Config` name is RESERVED (TS990015, pinned in reserved-config-names.t.ts —
// the native diagnostic rides the program, invisible to the in-process typecheck here). This
// pins the EMIT SHAPE of the error state: no `_`-suffix fallback (deleted), no generated
// alias statement (skipping it keeps a raw TS2300 duplicate out of the output), and the
// `static new` overload inlines the config type instead of referencing the alias.
it("skips the generated alias when the reserved config name is taken by the user", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        type ModelConfig = { custom : string }

        export class Model extends Base {
            public id!: string = ""
        }

        const user: ModelConfig = { custom : "x" }
        void user
    `))
    const printed         = printSourceFile(ts, transformedFile)
    const messages        = typecheckText(printed).join("\n")

    t.notMatch(printed, "ModelConfig_", "The pre-reservation underscore fallback is gone")
    t.notMatch(printed, "export type ModelConfig =", "No generated alias statement in the collision error state")
    t.match(printed, "static new(props:", "The static new overload survives with an inline config type")
    t.notMatch(messages, "TS2300", "The generated members do not duplicate the user's identifier")
})
