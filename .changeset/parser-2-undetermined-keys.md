---
"@dierkens.dev/ptcgl-battle-log-state": minor
---

Move the parser pin to `2.0.0`, where `templateKey` is `null` when a line cannot
say which of several identically printed keys produced it.

Such a line is lowered from its `candidateKeys` only when they agree: a board or
hand discard lowers as a discard either way, and lines whose candidates are all
ignored stay ignored (as `unmodelled` when their reasons differ). When the
candidates lower differently — `fr` heals (`healed` / `healed_dc`) and `ptbr`
shuffles (into deck / into hand) — the lowering emits a new `AmbiguousTemplate`
diagnostic and no event, rather than picking one. Ignored and unhandled entries
for such lines are keyed by every candidate joined with `" | "`.

Turn placements now arrive as `played_to_*` rather than `play_to_*`; both lower
the same way, so the fixtures' census is unchanged.
