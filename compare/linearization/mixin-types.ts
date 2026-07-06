import { mixinsWith } from "mixin-types"

// mixin-types composes mixin functions: (Base) => class extends Base
class Root {
    chain(): string { return "Root" }
}
const Left = (B: any) => class extends B {
    chain(): string { return `Left > ${super.chain()}` }
}
const Right = (B: any) => class extends B {
    chain(): string { return `Right > ${super.chain()}` }
}
class Combined extends mixinsWith(Root, Left, Right) {
    chain(): string { return `Combined > ${super.chain()}` }
}
console.log("mixin-types | basic:", new Combined().chain())

class Base {
    step(): string { return "Base" }
}
const Shared = (B: any) => class extends B {
    step(): string { return `Shared > ${super.step()}` }
}
const DLeft = (B: any) => class extends Shared(B) {
    step(): string { return `Left > ${super.step()}` }
}
const DRight = (B: any) => class extends Shared(B) {
    step(): string { return `Right > ${super.step()}` }
}
class DCombined extends mixinsWith(Base, DLeft, DRight) {
    step(): string { return `Combined > ${super.step()}` }
}
console.log("mixin-types | deep: ", new DCombined().step())

console.log("mixin-types | bad:  ", "no rejection (no order-constraint model; applies in given order)")

// ── instanceof (does the composed instance pass instanceof against its mixins?) ──
{
    const probe: any = new Combined()
    const refs: Array<[string, any]> = [["Left", Left], ["Right", Right], ["Root", Root]]
    const ok = refs.filter(([, C]) => { try { return probe instanceof C } catch { return false } }).map(([n]) => n)
    console.log("mixin-types | instanceof:", ok.length === 3 ? "✅ all" : ok.length ? `partial (${ok.join(",")})` : "❌ none")
}
