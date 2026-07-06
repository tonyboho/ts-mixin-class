import { mixin } from "ts-mixin-class"

// ── basic: Root ← Left, Right ──────────────────────────────────────────────
@mixin()
class Root {
    chain(): string {
        return "Root"
    }
}

@mixin()
class Left implements Root {
    chain(): string {
        return `Left > ${super.chain()}`
    }
}

@mixin()
class Right implements Root {
    chain(): string {
        return `Right > ${super.chain()}`
    }
}

class Combined implements Left, Right {
    chain(): string {
        return `Combined > ${super.chain()}`
    }
}

console.log("ts-mixin-class | basic:", new Combined().chain())

// ── deep: Base ← Shared ← DLeft, DRight (shared intermediate) ───────────────
@mixin()
class Base {
    step(): string {
        return "Base"
    }
}

@mixin()
class Shared implements Base {
    step(): string {
        return `Shared > ${super.step()}`
    }
}

@mixin()
class DLeft implements Shared {
    step(): string {
        return `Left > ${super.step()}`
    }
}

@mixin()
class DRight implements Shared {
    step(): string {
        return `Right > ${super.step()}`
    }
}

class DCombined implements DLeft, DRight {
    step(): string {
        return `Combined > ${super.step()}`
    }
}

console.log("ts-mixin-class | deep: ", new DCombined().step())

// ── instanceof (does the composed instance pass instanceof against its mixins?) ──
{
    const probe: any = new Combined()
    const refs: Array<[string, any]> = [["Left", Left], ["Right", Right], ["Root", Root]]
    const ok = refs.filter(([, C]) => { try { return probe instanceof C } catch { return false } }).map(([n]) => n)
    console.log("ts-mixin-class | instanceof:", ok.length === 3 ? "✅ all" : ok.length ? `partial (${ok.join(",")})` : "❌ none")
}
