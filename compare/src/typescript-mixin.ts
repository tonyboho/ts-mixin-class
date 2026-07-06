import "reflect-metadata"
import "typescript-mixin" // populates a global `Mixins` namespace with the decorators

// A class extends ONE real base and copies members from the others; `super` reaches only
// the real base, not the mixed-in classes.
const Mixins = (globalThis as any).Mixins

class Root {
    chain(): string { return "Root" }
}
class Left {
    chain(): string { return "Left" }
}
class Right {
    chain(): string { return "Right" }
}
interface Combined extends Left, Right {}
@Mixins.tmixin(Left, Right)
class Combined extends Root {
    chain(): string { return `Combined > ${super.chain()}` }
}
console.log("typescript-mixin | basic:", new Combined().chain())
console.log("typescript-mixin | deep: ", "n/a — super reaches the real base only; mixins copied")
console.log("typescript-mixin | bad:  ", "no rejection (no order-constraint model)")

{
    const probe: any = new Combined()
    const refs: Array<[string, any]> = [["Left", Left], ["Right", Right], ["Root", Root]]
    const ok = refs.filter(([, C]) => { try { return probe instanceof C } catch { return false } }).map(([n]) => n)
    console.log("typescript-mixin | instanceof:", ok.length === 3 ? "✅ all" : ok.length ? `partial (${ok.join(",")})` : "❌ none")
}
