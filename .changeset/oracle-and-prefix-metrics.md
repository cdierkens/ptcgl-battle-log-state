---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Add a `CardOracle` port and per-prefix confirmation metrics.

`census(events, { oracle })` accepts optional card data through a small port:
HP per printing, attack targetability, prize value, and evolution edges. The
ledger uses HP to rule out impossible knockouts and targetability to keep a
damage line on the Active Spot. The old `hp` callback is replaced by this port.

`LedgerRun.prefixes` reports confirmed/divergent/saturated counts for every
prefix and for turn boundaries; `census` exposes `confirmedPrefixRate` and
`stablePrefixRate`. The per-log headline is unchanged.

Also fixes the HP interval semantics: `min` is inclusive, and a survival at
damage `d` raises it to `d + 1`, so a knockout at `d` can be ruled out instead of
being attributed to a body whose HP is already known to be higher.
