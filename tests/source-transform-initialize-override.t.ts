import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import ts from "typescript"

import { printSourceFile, transformSourceFile } from "../src/index.js"
import { createSourceFile, typecheckText } from "./util.js"

// The `initialize`-override protocol across construction classes, mixins and chains
// (§7.14): a user types an `initialize` override with the strict `<Name>Config` alias;
// a consumer (or construction mixin) applying several such mixins must not hit a TS2320
// merge conflict — the generated `$base` interface re-declares the `Base.initialize`
// protocol member when the class declares no own override — while the merged config still
// requires every contributed field. The alias SHAPE itself is pinned in
// `source-transform-construction-config-alias.t.ts`.

it("lets a consumer type its initialize override with the strict config alias", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id!: string = ""
            public name?: string = ""

            override initialize(config: ModelConfig): void {
                super.initialize(config)
                this.name = config.name ?? config.id
            }
        }

        const created = Model.new({ id : "a" })
        void created
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "A strict-required initialize override typed with the alias produces no diagnostics")
})

it("keeps the initialize override body strictly typed against the config alias", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { Base } from "ts-mixin-class/base"

        class Model extends Base {
            public id!: string = ""

            override initialize(config: ModelConfig): void {
                super.initialize(config)
                void config.nope
            }
        }

        void Model
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.match(messages, "nope", "An unknown field inside the override body is still rejected")
})

it("lets a mixin type its initialize override with its own config alias and a consumer apply several such mixins", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class A extends Base {
            public a!: string = ""

            override initialize(config: AConfig): void {
                super.initialize(config)
                this.a = config.a
            }
        }

        @mixin()
        class B extends Base {
            public b!: number = 0

            override initialize(config: BConfig): void {
                super.initialize(config)
                this.b = config.b
            }
        }

        class C extends Base implements A, B {
            public c!: boolean = false
        }

        const created = C.new({ a : "x", b : 1, c : true })

        // The consumer's config requires each mixin's field; the @ts-expect-error directives
        // assert that (an unused one would surface as TS2578 and fail the empty check).

        // @ts-expect-error - 'a' (from mixin A) is required in the consumer config
        const missingA = C.new({ b : 1, c : true })
        // @ts-expect-error - 'b' (from mixin B) is required in the consumer config
        const missingB = C.new({ a : "x", c : true })

        void [ created, missingA, missingB ]
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    // Both mixins override initialize with their own strict config; the consumer's
    // generated base interface re-declares the Base.initialize protocol member, so the
    // merge no longer fails with TS2320 ("not identical").
    t.is(messages, "", "A consumer of several mixins that override initialize typechecks and requires each mixin's config field")
})

it("supports an initialize override through a mixin dependency chain", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class Identified extends Base {
            public id!: string = ""

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
            public audited!: boolean = false

            override initialize(config: IdentifiedConfig): void {
                super.initialize(config)
            }
        }

        class Record extends Base implements Audited {
            public name!: string = ""

            override initialize(config: RecordConfig): void {
                super.initialize(config)
            }
        }

        const created = Record.new({ id : "r1", audited : true, name : "n" })
        void created
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "A consumer of a mixin chain whose members override initialize typechecks")
})

it("lets a plain class extend a construction mixin and add a required config field", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class Timestamped extends Base {
            public createdAt!: Date = new Date()
        }

        // NOTE: extending a mixin directly is NOT the idiomatic pattern - a class should
        // INCLUDE a mixin via \`implements\` (or extend a plain class / \`Base\`), not inherit
        // from the mixin itself. But we support it anyway: the mixin's value-cast \`new\` is a
        // method (not a contravariant function-typed property), so a subclass that adds a
        // REQUIRED field keeps an assignable generated \`static new(props: EventConfig)\` - no
        // TS2417 static-side clash.
        class Event extends Timestamped {
            public name!: string = ""
        }

        const created = Event.new({ createdAt : new Date(), name : "x" })

        // @ts-expect-error - 'name' is required in the subclass config
        const missingName = Event.new({ createdAt : new Date() })

        void [ created, missingName ]
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "Extending a construction mixin and adding a required field typechecks (no TS2417 static-side clash)")
})

it("supports a three-level chain where each construction mixin/consumer overrides initialize with its own config", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class Mixin1 extends Base {
            public one!: string = ""
            override initialize(config: Mixin1Config): void { super.initialize(config) }
        }

        // Extends Base (so it has its own Mixin2Config) AND depends on Mixin1; overrides
        // initialize with its own config. Its generated $base extends Base + Mixin1, so it
        // gets the protocol member even though the class declares its own initialize.
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

        // @ts-expect-error - 'one' (from Mixin1) is required in the merged config
        const missingOne = Consumer.new({ two : 1, three : true })
        // @ts-expect-error - 'two' (from Mixin2) is required in the merged config
        const missingTwo = Consumer.new({ one : "x", three : true })
        // @ts-expect-error - 'three' (Consumer's own field) is required in the merged config
        const missingThree = Consumer.new({ one : "x", two : 1 })

        void [ created, missingOne, missingTwo, missingThree ]
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "A three-level chain each overriding initialize with its own config typechecks and accumulates the config")
})

it("lets a construction mixin apply several initialize-overriding mixins without its own override", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
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

        // A construction mixin that merges A and B but does NOT override initialize itself.
        // Its generated interface extends Base, A, B with non-identical inherited initialize;
        // the protocol member is injected so the merge does not fail with TS2320.
        @mixin()
        class Combined extends Base implements A, B {
            public x!: boolean = false
        }

        class Holder extends Base implements Combined {
            public h!: string = ""
        }

        const created = Holder.new({ a : "x", b : 1, x : true, h : "h" })

        // The merged config carries every contributed field as required; omitting any one
        // is a type error. The @ts-expect-error directives double as assertions: if the
        // config were assembled wrong (a field not required), the directive goes unused and
        // surfaces as TS2578, failing the empty-diagnostics check below.

        // @ts-expect-error - 'a' (from mixin A) is required in the merged config
        const missingA = Holder.new({ b : 1, x : true, h : "h" })
        // @ts-expect-error - 'b' (from mixin B) is required in the merged config
        const missingB = Holder.new({ a : "x", x : true, h : "h" })
        // @ts-expect-error - 'x' (from mixin Combined) is required in the merged config
        const missingX = Holder.new({ a : "x", b : 1, h : "h" })
        // @ts-expect-error - 'h' (Holder's own field) is required in the merged config
        const missingH = Holder.new({ a : "x", b : 1, x : true })

        void [ created, missingA, missingB, missingX, missingH ]
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    t.is(messages, "", "Merging mixins typechecks and the merged config requires every contributed field")
})

it("keeps a mixin's initialize override body strictly typed against its own config alias", async (t: Test) => {
    const transformedFile = transformSourceFile(ts, createSourceFile(`
        import { mixin } from "ts-mixin-class"
        import { Base } from "ts-mixin-class/base"

        @mixin()
        class A extends Base {
            public a!: string = ""

            override initialize(config: AConfig): void {
                super.initialize(config)
                void config.nope
            }
        }

        void A
    `))
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

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
    const messages        = typecheckText(printSourceFile(ts, transformedFile)).join("\n")

    // No package Base, so this is NOT a construction consumer: the protocol member is
    // not injected and a real, user-meaningful initialize conflict is not masked.
    t.match(messages, "TS2320", "A non-construction consumer of clashing plain initialize methods still reports TS2320")
})
