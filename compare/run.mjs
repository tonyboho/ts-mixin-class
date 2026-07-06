import { readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"

// Run every probe, capture its lines: "<lib> | basic|deep|bad|instanceof: <text>".
const results = {}
const record = (line) => {
    const m = line.match(/^(.+?) \| (basic|deep|bad|instanceof):\s*(.*)$/)
    if (m) (results[m[1]] ??= {})[m[2]] = m[3].trim()
}

const files = []
try { for (const f of readdirSync("dist-tsmc")) if (f.endsWith(".js")) files.push(`dist-tsmc/${f}`) } catch {}
try { for (const f of readdirSync("dist")) if (f.endsWith(".js") && f !== "polyfill.js") files.push(`dist/${f}`) } catch {}

for (const f of files) {
    let out = ""
    try { out = execFileSync("node", [f], { encoding: "utf8" }) }
    catch (e) { out = String(e.stdout || "") }
    out.split("\n").forEach(record)

    // ts-mixin-class "bad" case is a compile-time rejection: build the conflict fixture.
    if (f.includes("ts-mixin-class")) {
        let bad = "no rejection"
        try { execFileSync("npx", ["tspc", "-p", "tsconfig.conflict.json"], { encoding: "utf8" }) }
        catch (e) {
            const m = String(e.stdout || "").match(/error (TS\d+):/)
            if (m) bad = `REJECTED at compile (${m[1]})`
        }
        record(`ts-mixin-class | bad: ${bad}`)
    }
}

// ── Behavioural columns — derived from what each library actually did at runtime ──
const both = (s = "") => /Left/.test(s) && /Right/.test(s)
const reachesAll = (r) => both(r.basic) ? "✅" : "❌"
const dedup = (r) => {
    const d = r.deep ?? ""
    if (!both(d)) return "n/a" // a branch was dropped, or the model has no chain
    return (d.match(/Shared/g) || []).length === 1 ? "✅" : "❌"
}
const c3 = (r) => (r.deep ?? "").trim() === "Combined > Left > Right > Shared > Base" ? "✅" : "❌"
const rejects = (r) => /REJECTED/.test(r.bad ?? "") ? "✅" : "❌"
const iof = (r) => /✅ all/.test(r.instanceof ?? "") ? "✅" : /partial/.test(r.instanceof ?? "") ? "⚠️" : "❌"

// ── Structural columns — how the code is WRITTEN / what it costs (NOT observable at runtime,
//    so these are set by hand, not derived from the probes above) ──
//   native = plain classes + native `implements`/`extends`, no factory or decorator wrappers
//   zero   = composition happens at compile time, no runtime cost
//   gen    = full generic mixins & consumers  (⚠️ = only with manual workarounds)
const structural = {
    "ts-mixin-class":        { native: "✅", zero: "✅", gen: "✅" },
    "@alizurchik/ts-mixin":  { native: "❌", zero: "❌", gen: "⚠️" },
    "@open-wc/dedupe-mixin": { native: "❌", zero: "❌", gen: "⚠️" },
    "mixedin":               { native: "❌", zero: "❌", gen: "✅" },
    "mixin-types":           { native: "❌", zero: "❌", gen: "✅" },
    "mixwith":               { native: "❌", zero: "❌", gen: "❌" },
    "polytype":              { native: "❌", zero: "❌", gen: "✅" },
    "ts-mixer":              { native: "❌", zero: "❌", gen: "⚠️" },
    "typed-mixins":          { native: "❌", zero: "❌", gen: "❌" },
    "typescript-mix":        { native: "❌", zero: "❌", gen: "❌" },
    "typescript-mixin":      { native: "❌", zero: "❌", gen: "✅" },
}
const st = (l, k) => structural[l]?.[k] ?? "?"

const libs = Object.keys(results).sort((a, b) =>
    a === "ts-mixin-class" ? -1 : b === "ts-mixin-class" ? 1 : a.localeCompare(b))

console.log("Behavioural columns (Reaches all mixins, Dedup, C3 order, Rejects bad order, instanceof) are")
console.log("produced by running each library. Native / Zero runtime / Generics are structural (set by hand).\n")

const rows = [
    ["Library", "Native `implements`", "Reaches all mixins", "Dedup", "C3 order", "Rejects bad order", "instanceof", "Generics", "Zero runtime"],
    ["---", ":-:", ":-:", ":-:", ":-:", ":-:", ":-:", ":-:", ":-:"],
    ...libs.map((l) => {
        const r = results[l]
        return [
            l === "ts-mixin-class" ? `**${l}**` : l,
            st(l, "native"), reachesAll(r), dedup(r), c3(r), rejects(r), iof(r), st(l, "gen"), st(l, "zero"),
        ]
    }),
]
const w = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
for (const row of rows) console.log("| " + row.map((c, i) => c.padEnd(w[i])).join(" | ") + " |")
