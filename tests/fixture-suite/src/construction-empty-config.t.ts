import { Base, mixin } from "ts-mixin-class"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// Construction with an EMPTY config (§7.22): a construction class / consumer with no public
// data fields — `.new()` (no argument at all) and `.new({})` are both legal and build.

class Job extends Base {
    work(): string {
        return "worked"
    }
}

@mixin()
class Silent extends Base {
    hum(): string {
        return "hum"
    }
}

class Quiet extends Base implements Silent {
}

it("an empty-config construction class builds through .new() and .new({})", (t: Test) => {
    t.equal(Job.new().work(), "worked", "no-argument .new()")
    t.equal(Job.new({}).work(), "worked", "empty-object .new({})")
})

it("an empty-config construction CONSUMER builds the same", (t: Test) => {
    t.equal(Quiet.new().hum(), "hum", "no-argument .new() through the mixin chain")
    t.equal(Quiet.new({}).hum(), "hum", "empty-object .new({})")
})
