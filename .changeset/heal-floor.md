---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

A heal line no longer requires the Pokémon to have tracked damage: it removes up to its amount with a floor of 0, so it never reports HealOverflow and no longer eliminates a side for an unnamed-owner heal. The client printed a heal on a provably undamaged Pokémon.
