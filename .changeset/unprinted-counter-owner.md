---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Stop trusting the side printed on counter heals and moves. The client names the acting card's owner on `healed_dc` and moved-counter lines, not the target's, so `HealEvent` and `MoveCountersEvent` now carry `ownerPrinted`. The ledger applies those lines to the side whose board can carry them, forking when both can, and an owner-unnamed line no longer stops the knockout-lethal search.
