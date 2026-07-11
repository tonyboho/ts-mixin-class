# Required-base plan — remaining items

The 2026-07 review of the multiple-required-bases feature is fully executed (all P0/P1/P2
findings fixed, pinned RED→GREEN; see git history for the details). What remains is the
deliberately deferred item below — it degrades SAFELY today.

1. **A required-base bench scenario.** The generated bench corpus has no required bases,
   so the resolver's heavy path (deep compatible-base chains) is not measured by
   `pnpm bench`. An isolated measurement showed super-linear growth with constraint count
   (~2.6ms @40 → ~48ms @320 constraints per context build) — fine for realistic projects,
   but a corpus scenario should pin it before required-base-heavy projects appear.
