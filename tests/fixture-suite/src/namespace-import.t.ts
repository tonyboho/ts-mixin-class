import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

import { mixin } from "ts-mixin-class"
import * as lib from "./mixins.js"

// Mixins referenced through a NAMESPACE import (`import * as lib` + `implements
// lib.Named`) — the qualified reference resolves through the namespace binding to the
// declaring module's registry entry, and the generated machinery references the value as
// `lib.Named` (a property access off the namespace object). Covers a plain consumer and a
// local `@mixin` whose DEPENDENCY is qualified; part of the stress corpus, so both shapes
// are also swept on the source-view plane.

class QualifiedUser implements lib.Named {
}

@mixin()
class Stamper implements lib.Named {
    stamp(): string {
        return "stamp:" + this.label()
    }
}

class StamperUser implements Stamper {
}

it("namespace-imported mixins resolve for consumers and as mixin dependencies", (t: Test) => {
    t.equal(new QualifiedUser().label(), "Ada", "the consumer gained the qualified mixin's member")
    t.equal(new StamperUser().stamp(), "stamp:Ada", "the local mixin's qualified dependency rode through the chain")
})
