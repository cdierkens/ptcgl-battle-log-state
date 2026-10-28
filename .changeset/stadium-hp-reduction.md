---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Explain knockouts under a Stadium that lowers HP, such as Gravity Mountain:

- `CardPrinting` gains a required `stage`.
- `StadiumFacts` gains `hpReduction`, read from English text by the new `hpReductionFromText`.
- A knockout is explained when damage reaches printed HP minus the reduction, for any body whose stage matches or is unknown. The Stadium may have left play, so the reduction only widens the knockout candidates and never narrows them.
