---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

Read a heal line as healing up to its amount. The client logs the effect's amount rather than the damage it removed, and logs a heal only for a damaged Pokémon, so a heal larger than the tracked damage no longer reports HealOverflow; a heal on a body with no damage still does.
