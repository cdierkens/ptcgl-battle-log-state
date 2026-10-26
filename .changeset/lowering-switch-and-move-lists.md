---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

Fix two lowerings the ledger exposed.

`blog_loc_switched_active` had its placeholders reversed: the template's
`targetCardName` is the card that becomes Active, and `sourceCardName` is the one
that leaves. The ledger was swapping the wrong bodies.

`move_to_*`, `shuffled_*`, and `discarded_*` lines carry a count phrase in the
placeholder and the real card names in the `•` list. The lowering now emits one
`moveCard` per named card, so a Pokémon moved off the board leaves it instead of
staying under the phantom name `2 cards`.
