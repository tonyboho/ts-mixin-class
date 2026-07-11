# Required-base plan — remaining items

The 2026-07 review of the multiple-required-bases feature is fully executed (all P0/P1/P2
findings fixed, pinned RED→GREEN, gate 70/70; see git history for the details). What
remains are the deliberately deferred items below — each degrades SAFELY today.

1. **Cross-package GENERIC constraints through `.d.ts` markers.** The published
   `RuntimeMixinClass<Base>` marker erases a generic mixin's type-parameter mapping, so a
   generic required base imported from a declarations-only package cannot be ordered at
   compile time. Current behavior: the relation degrades to "unknown" → the resolution is
   INDETERMINATE → no diagnostic, no plan index — the runtime scan (which sees real
   constructors) resolves the base precisely. Never a false TS990013; only a missed
   compile-time check/optimization. A fix would need the marker (or the public `mix`
   signature) to retain the parameter mapping.

2. **A required-base bench scenario.** The generated bench corpus has no required bases,
   so the resolver's heavy path (deep compatible-base chains) is not measured by
   `pnpm bench`. An isolated measurement showed super-linear growth with constraint count
   (~2.6ms @40 → ~48ms @320 constraints per context build) — fine for realistic projects,
   but a corpus scenario should pin it before required-base-heavy projects appear.

3. **A tsserver-plane test for TS990013/TS990014.** Source view is exercised via
   `tsc --noEmit` (the same diagnostic code path); the three-planes convention still wants
   an explicit `tsserver-diagnostics.t.ts` case for the two codes.
