---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Apply effects through the acting card's text:

- **Breaking for oracle builders:** `CardAttack` gains `spread` and `leavesPlay`, and `CardPrinting` gains `abilities` (`CardAbility[] | null`, Abilities only). `counterSpreadFromText` and `leavesPlayFromText` read both facts from English card text.
- A counter run printed right after an effect with a known spread is placed through that effect's scope, relative to the acting card: an `each` spread must mark every qualifying Pokémon, and a world that leaves one unmarked is pruned (`SpreadUnmarked` when none is left). A `choice` spread puts each line on a different reachable body, and the lines must add up to the stated counters. A Checkup effect resolves once per body of the acting card. A run that fits no board is reported as `SpreadMismatch` and placed as before.
- New `PreventedEvent` for "Damage to X was prevented."; inside a spread it counts as the effect reaching X.
- A move to hand or deck that follows a Pokémon's own effect (a bare "played X", or X's attack or Ability) takes that Pokémon out of play when its card text says the effect returns it with its attached cards.
