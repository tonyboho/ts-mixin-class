import { mix, Mixin } from "mixwith"

// In mixwith a mixin is a subclass factory: (superclass) => class extends superclass
class Root {
    chain(): string { return "Root" }
}
const Left = Mixin((s: any) => class extends s {
    chain(): string { return `Left > ${super.chain()}` }
})
const Right = Mixin((s: any) => class extends s {
    chain(): string { return `Right > ${super.chain()}` }
})
class Combined extends mix(Root).with(Left, Right) {
    chain(): string { return `Combined > ${super.chain()}` }
}
console.log("mixwith | basic:", new Combined().chain())

// deep: a shared intermediate mixin used by both branches
class Base {
    step(): string { return "Base" }
}
const Shared = Mixin((s: any) => class extends s {
    step(): string { return `Shared > ${super.step()}` }
})
const DLeft = Mixin((s: any) => class extends Shared(s) {
    step(): string { return `Left > ${super.step()}` }
})
const DRight = Mixin((s: any) => class extends Shared(s) {
    step(): string { return `Right > ${super.step()}` }
})
class DCombined extends mix(Base).with(DLeft, DRight) {
    step(): string { return `Combined > ${super.step()}` }
}
console.log("mixwith | deep: ", new DCombined().step())

console.log("mixwith | bad:  ", "no rejection (no order-constraint model; applies in given order)")

// ── instanceof (does the composed instance pass instanceof against its mixins?) ──
{
    const probe: any = new Combined()
    const refs: Array<[string, any]> = [["Left", Left], ["Right", Right], ["Root", Root]]
    const ok = refs.filter(([, C]) => { try { return probe instanceof C } catch { return false } }).map(([n]) => n)
    console.log("mixwith | instanceof:", ok.length === 3 ? "✅ all" : ok.length ? `partial (${ok.join(",")})` : "❌ none")
}
