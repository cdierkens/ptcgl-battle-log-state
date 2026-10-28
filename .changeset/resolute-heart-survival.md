---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

Don't infer printed HP from surviving a hit that the card's own effect heals back in the same phase. Resolute Heart prints the damage it undoes as a heal after the hit, so the survival bound wrongly raised HP above the printing and later knockouts looked unproven.
