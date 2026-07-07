import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { buildConstructionSource, readConstructionConfigDts } from "./construction-build-util.js"
import { commandOutput, trimIndent } from "./util.js"

// §7 × §6: a GENERIC construction-base mixin (`@mixin() class Repo<T> extends Base`).
// Generic construction CLASSES already get a typed `.new<T>` (§7.10) — the mixin form was
// excluded, so a standalone `Repo.new(...)` fell back to the inherited `Base.new` (untyped
// config, `Base` return). The mixin must get the same treatment: `.new<T>(props: RepoConfig<T>):
// Repo<T>` (explicit or inferred), the config alias generic, and the direct-`new` ban kept.

const genericConstructionMixin = trimIndent(`
    import { Base, mixin } from "ts-mixin-class"

    @mixin()
    export class Repo<T> extends Base {
        public item!: T

        public label: string = "repo"

        describe(): string {
            return this.label
        }
    }

    const dates = Repo.new<Date>({ item: new Date(), label: "dates" })
    const dateItem: Date = dates.item

    const inferred = Repo.new({ item: 42 })
    const numberItem: number = inferred.item

    class NumberRepo implements Repo<number> {
    }

    const fixed = NumberRepo.new({ item: 7 })
    const fixedItem: number = fixed.item

    function typeOnlyChecks(): void {
        // @ts-expect-error the required config key is enforced per instantiation
        Repo.new<Date>({ label: "missing item" })

        // @ts-expect-error the config key is typed by the fixed parameter
        Repo.new<Date>({ item: 5 })

        // @ts-expect-error direct new is banned — construction goes through .new
        new Repo<Date>()
    }

    void typeOnlyChecks
    void [ dateItem, numberItem, fixedItem ]
`)

it("a generic construction mixin gets a typed standalone .new<T> (emit)", async (t: Test) => {
    const result = await buildConstructionSource(genericConstructionMixin)

    t.equal(
        result.exitCode,
        0,
        `explicit + inferred .new, a consumer fixing T, and the direct-new ban all hold.\n${commandOutput(result)}`
    )
})

it("a generic construction mixin gets a typed standalone .new<T> (source view)", async (t: Test) => {
    const result = await buildConstructionSource(genericConstructionMixin, { noEmit: true })

    t.equal(result.exitCode, 0, `the source-view plane agrees.\n${commandOutput(result)}`)
})

it("the generic mixin's config alias is generic in the declarations", async (t: Test) => {
    const dts = await readConstructionConfigDts(genericConstructionMixin)

    t.match(dts, "RepoConfig<T>", `the alias carries the mixin's type parameter.\n${dts}`)
})
