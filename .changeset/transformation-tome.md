---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Follow Trainers that put a Pokémon into play in place of one in play (Transformation Tome). A new optional `CardOracle.trainer` port returns `TrainerFacts`, and `replacesInPlayFromText` reads `replacesInPlay` from English card text. With that fact, "moved A to the Bench" followed by "moved B to the discard pile" puts A in B's zone with B's attached cards. That removes false Bench overflows and Active Spot mismatches.
