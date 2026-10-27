---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Prune more impossible worlds and stop inventing knockout gaps:

- A knockout is matched to its damage across the following Checkup, up to the next knockout of that card or a phase boundary, and a knockout of the card whose own effect just acted is no longer `KnockoutUnproven`.
- Survivals that push a body's minimum HP above its known maximum are pruned; when no candidate survives, the new `HpExceeded` diagnostic is reported.
- Checkup effects printed after the knockouts they cause are applied first.
- Owner-unnamed counter lines printed as one run are one effect step: k lines naming one card land on k distinct bodies.
- A knockout may take a lethal body from any zone.
