---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Add the board ledger and the fork census.

`runLedger(events)` follows the lowered log forward into identity groups. Damage,
attachment, evolution, retreat, switch, knockout, and hidden-zone events update a
group as a set of value multisets, so permutations are never enumerated. HP and
survival bounds are learnt per body from the log; `hp` is the seam for an
informed run with card data. Nothing is guessed: a side the log named wrongly is
resolved by elimination and reported, and an event with no surviving variant is
a diagnostic.

`census(events)` reduces the ledger to the three figures the design promised:
never confirmed, ever divergent, and confirmed late. It is a forward pass, not
the full solver, and it can only over-report — the upper-bound direction.

`pnpm run census:fixtures` runs the aggregation over the committed logs. The
first corpus measurement is in `docs/audits/2026-10-26-fork-census.md`.
