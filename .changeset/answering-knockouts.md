---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Explain two knockouts that print no damage.

- `KnockoutReach` gains `"attacker"`, and `knocksOutFromText` reads "the Attacking Pokémon is Knocked Out." as it (Fainting Spell, Destiny Bond, Perish Body). A knockout of a Pokémon that attacked such a card, Knocked Out earlier in the same phase, is no longer `KnockoutUnproven`.
- A bare "played X" naming the Active Pokémon is the export's print of X's attack with no damage line, so a knockout of the other side after it, with no damage or counter line between, is no longer `KnockoutUnproven`.
