import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { mixin } from "ts-mixin-class"
import { Base } from "ts-mixin-class/base"

// A QUALIFIED construction base: `Widget extends data.Model` where the namespace-nested
// `data.Model extends Base`. The construction pipeline follows the dotted reference, so
// the consumer gets its own generated `static new` and a `WidgetConfig` that accumulates
// the base's config keys THROUGH the qualified chain (required `modelId` included — an
// empty accumulation would silently accept any object).

namespace data {
    export class Model extends Base {
        public modelId!: string = ""
        public modelValue?: number = 0
    }
}

@mixin()
class Tagged {
    public tag?: string = ""

    tagged(): string {
        return `#${this.tag ?? ""}`
    }
}

export class Widget extends data.Model implements Tagged {
    public ownValue?: boolean = false

    override initialize(config?: WidgetConfig): void {
        super.initialize(config)
    }
}

const widget = Widget.new({
    modelId    : "w1",
    modelValue : 7,
    ownValue   : true,
    tag        : "t"
})

const t1: string = widget.modelId
const t2: number | undefined = widget.modelValue
const t3: boolean | undefined = widget.ownValue
const t4: string | undefined = widget.tag

// @ts-expect-error the qualified base's required key is accumulated into the config.
Widget.new({ tag: "t" })

// @ts-expect-error the config rejects unknown properties.
Widget.new({ modelId: "w2", missing: 1 })

// @ts-expect-error the base field stays number through the qualified chain.
Widget.new({ modelId: "w2", modelValue: "seven" })

// @ts-expect-error direct construction is disabled - use `Widget.new`.
new Widget()

const model = data.Model.new({ modelId: "m1" })

it("a consumer of a qualified construction base constructs through its generated static new", (t: Test) => {
    t.isInstanceOf(widget, Widget, ".new returns the consumer instance")
    t.isInstanceOf(widget, data.Model, "the runtime chain goes through the namespace value")
    t.isInstanceOf(widget, Tagged, "the mixin stays in the runtime chain")
    t.equal(widget.modelId, "w1", "the qualified base's required config key is assigned")
    t.equal(widget.modelValue, 7, "the qualified base's optional config key is assigned")
    t.equal(widget.ownValue, true, "the consumer's own config key is assigned")
    t.equal(widget.tagged(), "#t", "the mixin's config key is assigned and its member works")
    t.isInstanceOf(model, data.Model, "the nested base itself still constructs through .new")
    t.equal(model.modelId, "m1", "the nested base's own config is assigned")
})

void [ t1, t2, t3, t4 ]
