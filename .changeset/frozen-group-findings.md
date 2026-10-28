---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

Stop checking events against a saturated group. Once a group hits the variant cap it is frozen, so later knockout, zone, attachment and HP checks against it reported the freeze rather than the log. `Saturated` already marks the group as unchecked. Line-level findings (`SideAmbiguous`, `SideMismatch`, `NoVariant`) and the side-level `BenchOverflow` still report.
