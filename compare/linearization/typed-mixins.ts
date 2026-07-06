import { mixin } from "typed-mixins"

class Root {
    chain(): string { return "Root" }
}
class Left extends Root {
    chain(): string { return `Left > ${super.chain()}` }
}
class Right extends Root {
    chain(): string { return `Right > ${super.chain()}` }
}
class Combined extends mixin(Left, [Right]) {
    chain(): string { return `Combined > ${super.chain()}` }
}
console.log("typed-mixins | basic:", new Combined().chain())

class Base {
    step(): string { return "Base" }
}
class Shared extends Base {
    step(): string { return `Shared > ${super.step()}` }
}
class DLeft extends Shared {
    step(): string { return `Left > ${super.step()}` }
}
class DRight extends Shared {
    step(): string { return `Right > ${super.step()}` }
}
class DCombined extends mixin(DLeft, [DRight]) {
    step(): string { return `Combined > ${super.step()}` }
}
console.log("typed-mixins | deep: ", new DCombined().step())

class A { a(): string { return "A" } }
class B { b(): string { return "B" } }
class X extends mixin(A, [B]) {}
class Y extends mixin(B, [A]) {}
let bad: string
try { class Z extends mixin(X, [Y]) {} ; new Z(); bad = "composed, no error (no conflict detection)" }
catch (e: any) { bad = "throws: " + String(e.message).slice(0, 40) }
console.log("typed-mixins | bad:  ", bad)

// ── instanceof (does the composed instance pass instanceof against its mixins?) ──
{
    const probe: any = new Combined()
    const refs: Array<[string, any]> = [["Left", Left], ["Right", Right], ["Root", Root]]
    const ok = refs.filter(([, C]) => { try { return probe instanceof C } catch { return false } }).map(([n]) => n)
    console.log("typed-mixins | instanceof:", ok.length === 3 ? "✅ all" : ok.length ? `partial (${ok.join(",")})` : "❌ none")
}
