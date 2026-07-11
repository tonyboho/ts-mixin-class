import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { Base } from "ts-mixin-class"
import { ConstructionScaled, Scaled } from "ts-mixin-class-fixture-suite/mixins"

// §13 × §1.27: the generated mixin interface's REAL get/set signatures — including a SPLIT
// pair's distinct read/write types — survive the package's declaration (`.d.ts`) round trip.
// The consumer below types entirely against the emitted declarations.
class Poster implements Scaled {
}

const poster = new Poster()

const read: number = poster.scale

void read

// Type-only negative check (never executed): the split setter's type comes from the
// declarations, not from a collapsed property signature.
function typeOnlyChecks(): void {
    // @ts-expect-error the setter accepts number | string, not boolean
    poster.scale = true
}
void typeOnlyChecks

it("a split accessor pair through package declarations", async (t: Test) => {
    const p = new Poster()

    p.scale = "2.5"
    t.equal(p.height, 25, "the string branch of the split setter fires through the declaration package")

    p.scale = 4
    t.equal(p.height, 40, "…and the number branch")
    t.equal(p.scale, 4, "the getter reads back as a number")
})

// The construction-config twin: this consumes ONLY the published `.d.ts`. The getter reads
// `number`, but Object.assign invokes the setter, so both the standalone mixin and a downstream
// construction consumer must accept the setter's `number | string` input type.
class ConstructionPoster extends Base implements ConstructionScaled {
    public title!: string
}

const standaloneConstruction = ConstructionScaled.new({ scale: "2.5" })
const consumerConstruction = ConstructionPoster.new({ scale: "3", title: "poster" })

function constructionTypeOnlyChecks(): void {
    // @ts-expect-error the published setter accepts number | string, not boolean
    ConstructionScaled.new({ scale: true })

    // @ts-expect-error the consumer keeps its own required key through the package boundary
    ConstructionPoster.new({ scale: 2 })
}

it("a construction split accessor keeps its setter type through package declarations", async (t: Test) => {
    t.equal(standaloneConstruction.scale, 2.5, "the declaration mixin's own .new invokes the string setter")
    t.equal(consumerConstruction.scale, 3, "the downstream construction consumer invokes the same setter")
    t.equal(consumerConstruction.title, "poster", "the consumer's own config key is retained")
})

void constructionTypeOnlyChecks
