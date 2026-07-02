import { Base } from "ts-mixin-class/base"

import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"

// §7 boundary: config LAYERING down a construction subclass chain — a subclass re-declares an
// inherited optional key with a NEW DEFAULT, and adds its own REQUIRED key alongside the
// inherited ones.
class Document extends Base {
    public title: string = "untitled"

    public pages: number = 0
}

class SignedDocument extends Document {
    // A new default for the inherited optional key.
    public title: string = "unsigned"

    // A subclass-added REQUIRED key (definite-assignment `!`).
    public signer!: string
}

const plain  = Document.new({})
const signed = SignedDocument.new({ signer: "alice" })
const custom = SignedDocument.new({ signer: "bob", title: "contract", pages: 3 })

// Compile-time half: the subclass requires its own key…
// @ts-expect-error signer is required on the subclass
SignedDocument.new({})

// …while the base does not know it.
// @ts-expect-error signer is not a Document config key
Document.new({ signer: "alice" })

it("config layers down a construction subclass chain", async (t: Test) => {
    t.equal(plain.title, "untitled", "the base default applies to the base")
    t.equal(signed.title, "unsigned", "the subclass RE-DEFAULT wins on the subclass")
    t.equal(signed.pages, 0, "an untouched inherited default still applies")
    t.equal(signed.signer, "alice", "the subclass required key is assigned")

    t.equal(custom.title, "contract", "an explicit config value overrides the re-default")
    t.is(custom.pages, 3, "an inherited key stays settable on the subclass")

    t.true(signed instanceof Document, "the chain is intact")
})
