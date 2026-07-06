import { classes } from "polytype"

// polytype does real multiple inheritance via `extends classes(...)`.
class Root {
    chain(): string { return "Root" }
}
class Left extends Root {
    chain(): string { return `Left > ${super.chain()}` }
}
class Right extends Root {
    chain(): string { return `Right > ${super.chain()}` }
}
class Combined extends classes(Left, Right) {
    chain(): string { return `Combined > ${super.chain()}` }
}
let basic: string
try {
    basic = new Combined().chain()
} catch (e: any) {
    basic = "THROWS: " + String(e.message).split("\n")[0].slice(0, 70)
}
console.log("polytype | basic:", basic)
console.log("polytype | deep: ", "n/a (see basic)")
console.log("polytype | bad:  ", "no rejection (no order-constraint model)")

// ── instanceof (does the composed instance pass instanceof against its mixins?) ──
{
    const probe: any = new Combined()
    const refs: Array<[string, any]> = [["Left", Left], ["Right", Right], ["Root", Root]]
    const ok = refs.filter(([, C]) => { try { return probe instanceof C } catch { return false } }).map(([n]) => n)
    console.log("polytype | instanceof:", ok.length === 3 ? "✅ all" : ok.length ? `partial (${ok.join(",")})` : "❌ none")
}
