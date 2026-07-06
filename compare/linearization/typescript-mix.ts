import { use } from "typescript-mix"

// typescript-mix has no super chain: @use copies each mixin's own members onto the
// class. When two mixins define the same method, the last one simply wins.
class Left {
    chain(): string { return "Left (no super)" }
}
class Right {
    chain(): string { return "Right (no super)" }
}
interface Combined extends Left, Right {}
class Combined {
    @use(Left, Right) private mixins!: void
}
console.log("typescript-mix | basic:", new Combined().chain())
console.log("typescript-mix | deep: ", "n/a — no super chain (members copied, last wins)")
console.log("typescript-mix | bad:  ", "no rejection (no order-constraint model)")

{
    const probe: any = new Combined()
    const ok = [["Left", Left], ["Right", Right]].filter(([, C]) => { try { return probe instanceof (C as any) } catch { return false } })
    console.log("typescript-mix | instanceof:", ok.length ? "partial" : "❌ none")
}
