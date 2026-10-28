---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

Read attachment discard lines the way the client writes them. The client folds every attachment leaving one side's Bench in a single action into one line and names only the first body. A Benched body named on a multi-card line may now give part of the list, with other Benched bodies on that side giving the rest. A Bench trim's line may hold the joint pile of every trimmed body. The line names the acting player, so a discard the printed side cannot hold now crosses to the other side with a `SideMismatch` (Crushing Hammer).
