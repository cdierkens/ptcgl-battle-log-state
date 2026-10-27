---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Stop guessing a placed counter's side.

`CounterDamageEvent` gains a required `ownerPrinted` field: `true` for a Special
Condition line, `false` for a placed-counter line, whose printed player is the
owner of the card that placed the counters, not the target's owner.

The ledger no longer puts an unprinted-owner placement on the printed side when
both sides have the card. Each side's group forks into "received" and "did not"
and reports `SideAmbiguous`; a later heal can prune a side. A following knockout
is now looked for on the side the counters landed on, so elimination cases no
longer claim a knocked-out body survived.
