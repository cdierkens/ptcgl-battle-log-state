---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

`blog_loc_healed_dc` lowers its amount as damage, not damage counters. Its placeholder is named `numDamageCounters`, but every locale prints damage ("was healed for 30 damage."), so the ledger healed ten times too much.
