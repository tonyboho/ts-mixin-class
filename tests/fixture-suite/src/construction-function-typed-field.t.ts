import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base } from "ts-mixin-class/base"

// §7.5 / §7.7 boundary: a public FUNCTION-TYPED DATA FIELD (`handler: () => void`) on a
// construction class must be INCLUDED in `.new` config — it is an assignable property,
// not a method — whereas a declared METHOD with the same call shape stays EXCLUDED. The
// config builder keys on declaration kind (property vs method), not on whether the type
// happens to be a function.
class Widget extends Base {
    public label!: string = ""
    public onClick!: () => string = () => "default"

    // A declared method — excluded from config even though its type is also a function.
    describe(): string {
        return `${this.label}:${this.onClick()}`
    }
}

const widget = Widget.new({ label : "ok", onClick : () => "clicked" })

// Type-only negative check (never executed): the declared method is not a config key.
function typeOnlyChecks(): void {
    // @ts-expect-error `describe` is a method, excluded from construction config.
    Widget.new({ label : "x", describe : () => "y" })
}
void typeOnlyChecks

it("construction function-typed field included, method excluded", async (t: Test) => {
    t.equal(widget.label, "ok", "the plain data field is assigned from config")
    t.equal(widget.onClick(), "clicked",
        "the function-typed data field is included in config and assigned (fires the supplied function)")
    t.equal(widget.describe(), "ok:clicked",
        "the declared method runs and sees the config-assigned function field")
})
