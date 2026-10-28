---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Explain knockouts caused by effect text rather than damage. `CardAttack` and `CardAbility` gain a required `knocksOut` fact (`knocksOutFromText` reads it), "X chose Y" lowers to a `choice` event, and the optional `CardOracle.attack` looks up an attack copied by choice. A knockout of the opponent's Pokémon right after such an effect (Terminal Period, or Destined Fight copied by Seek Inspiration) is no longer reported as `KnockoutUnproven`.
