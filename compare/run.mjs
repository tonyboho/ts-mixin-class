import { readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"

// Run every probe, capture its three lines: "<lib> | basic|deep|bad: <text>".
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

// Derive the feature columns from the observed outputs.
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

const libs = Object.keys(results).sort((a, b) =>
    a === "ts-mixin-class" ? -1 : b === "ts-mixin-class" ? 1 : a.localeCompare(b))

console.log("Empirical results — every cell is produced by actually running the library.")
console.log("basic: Root <- Left, Right    deep: Base <- Shared <- Left, Right    bad: impossible order\n")

const rows = [
    ["Library", "All mixins (basic)", "Dedup (deep)", "C3 order (deep)", "Rejects bad order", "instanceof"],
    ["---", ":-:", ":-:", ":-:", ":-:", ":-:"],
    ...libs.map((l) => {
        const r = results[l]
        return [l === "ts-mixin-class" ? `**${l}**` : l, reachesAll(r), dedup(r), c3(r), rejects(r), iof(r)]
    }),
]
const w = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
for (const row of rows) console.log("| " + row.map((c, i) => c.padEnd(w[i])).join(" | ") + " |")

console.log("\nRaw super-chain output per library:")
for (const l of libs) console.log(`  ${l.padEnd(22)} basic=[${results[l].basic ?? "—"}]  deep=[${results[l].deep ?? "—"}]`)
