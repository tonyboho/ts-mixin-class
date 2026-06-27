import { it } from "@bryntum/siesta/nodejs.js"
import type { Test } from "@bryntum/siesta/nodejs.js"
import { Base } from "ts-mixin-class"

// Exercises the generated `<ClassName>Config` alias as a *source-referenced* symbol:
// it is named in `initialize` parameter types, in standalone annotations, and at
// `.new(...)` call sites - for a plain class and a generic one. Living in the
// fixture-suite corpus, this makes the alias identifier a target for every stress probe
// (rename, go-to-definition, quickinfo, references, edit) and the diagnostic-parity /
// trivia-strand sweeps, so a regression in the alias's synthetic positioning surfaces as
// a server crash or a parity failure rather than silently.

// --- Non-generic ---------------------------------------------------------------

class Account extends Base {
    public id!: string = ""
    public balance!: number = 0
    public label?: string

    // The strict alias is a valid `initialize` parameter type for a non-mixin class.
    override initialize(config?: AccountConfig): void {
        super.initialize(config)

        this.label = this.label ?? this.id
    }

    summary(): string {
        return `${this.id}:${this.balance}`
    }
}

// Standalone annotation use of the alias.
const accountConfig: AccountConfig = { id : "a2", balance : 50, label : "saver" }
const account: Account = Account.new({ id : "a1", balance : 100 })

// --- Generic -------------------------------------------------------------------

class Box<T> extends Base {
    public value!: T
    public tag!: string = ""

    // The generic alias `BoxConfig<T>` reuses the class type parameter in the override.
    override initialize(config?: BoxConfig<T>): void {
        super.initialize(config)

        this.tag = this.tag || "box"
    }

    unwrap(): T {
        return this.value
    }
}

const boxConfig: BoxConfig<boolean> = { value : true, tag : "flag" }
const numberBox = Box.new<number>({ value : 7, tag : "n" })
const inferredBox = Box.new({ value : "hello", tag : "s" })

it("uses the generated config alias for instantiation and initialize", async (t: Test) => {
    t.isInstanceOf(account, Account, "Account.new returns an Account")
    t.equal(account.id, "a1", "Required config field is assigned")
    t.equal(account.balance, 100, "Required numeric config field is assigned")
    t.equal(account.label, "a1", "initialize derived the optional field from the id")
    t.equal(account.summary(), "a1:100", "Instance methods work alongside the alias-typed initialize")

    t.equal(accountConfig.id, "a2", "Alias-typed annotation holds the config object")

    t.equal(numberBox.unwrap(), 7, "Generic .new<number> assigns the typed value")
    t.equal(numberBox.tag, "n", "Generic config tag is assigned")
    t.equal(inferredBox.unwrap(), "hello", "Inferred generic .new assigns the typed value")
    t.equal(boxConfig.value, true, "Generic alias annotation holds the config object")
})

void [ accountConfig, account, boxConfig, numberBox, inferredBox ]
