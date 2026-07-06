// mixedin relies on Map.prototype.getOrInsertComputed, which Node 24 does not ship.
// Provide it so the library can run at all.
const proto = Map.prototype as any
if (typeof proto.getOrInsertComputed !== "function") {
    proto.getOrInsertComputed = function (key: unknown, compute: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key)
        const value = compute(key)
        this.set(key, value)
        return value
    }
}
