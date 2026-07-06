import { dedupeMixin } from "@open-wc/dedupe-mixin"

class Root {
    chain(): string { return "Root" }
}
const Left = dedupeMixin((s: any) => class extends s {
    chain(): string { return `Left > ${super.chain()}` }
})
const Right = dedupeMixin((s: any) => class extends s {
    chain(): string { return `Right > ${super.chain()}` }
})
class Combined extends Right(Left(Root)) {
    chain(): string { return `Combined > ${super.chain()}` }
}
console.log("@open-wc/dedupe-mixin | basic:", new Combined().chain())

class Base {
    step(): string { return "Base" }
}
const Shared = dedupeMixin((s: any) => class extends s {
    step(): string { return `Shared > ${super.step()}` }
})
const DLeft = (s: any) => class extends Shared(s) {
    step(): string { return `Left > ${super.step()}` }
}
const DRight = (s: any) => class extends Shared(s) {
    step(): string { return `Right > ${super.step()}` }
}
class DCombined extends DRight(DLeft(Base)) {
    step(): string { return `Combined > ${super.step()}` }
}
console.log("@open-wc/dedupe-mixin | deep: ", new DCombined().step())

console.log("@open-wc/dedupe-mixin | bad:  ", "no rejection (dedupe only; no order-constraint model)")

// ── instanceof (does the composed instance pass instanceof against its mixins?) ──
{
    const probe: any = new Combined()
    const refs: Array<[string, any]> = [["Left", Left], ["Right", Right], ["Root", Root]]
    const ok = refs.filter(([, C]) => { try { return probe instanceof C } catch { return false } }).map(([n]) => n)
    console.log("@open-wc/dedupe-mixin | instanceof:", ok.length === 3 ? "✅ all" : ok.length ? `partial (${ok.join(",")})` : "❌ none")
}
