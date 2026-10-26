---
"@dierkens.dev/ptcgl-battle-log-state": patch
---

Stop reconciling damage breakdowns against their printed total, and carry them as
printed instead.

Two rules were tried against real data and both were falsified. Requiring the
components to equal the total flagged honest partial breakdowns; requiring only
that they not exceed it flagged duplicated component lines
(`Base 60, Damage 170, Damage 170, Total 230`) and hits that legitimately carry
`0`. Over a 411-log corpus the second rule produced 28 findings, all artefacts of
the check rather than the lowering.

`LoweringDiagnostic` no longer includes the `BreakdownMismatch` code. No
diagnostic of that kind was ever emitted outside the audit, so the practical
change is that `lower()` no longer reports a false positive.
