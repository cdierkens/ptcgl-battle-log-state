# Implementation prompt — the two cheap solvability fixes

## Role

You are implementing the two structural fixes in
[the export-defect findings](../audits/2026-10-27-export-defect-and-solvability.md).
The goal is to move the **turn-boundary board** confirmation rate. The
per-group rate is already 79.2%; the board rate is 58.1%, and card data alone did
not move it to 80%.

Do not build the full solver in this task. Do not package card data. Do not
change the parser.

## Read first

- `docs/audits/2026-10-27-export-defect-and-solvability.md` — the findings and
  the exact counts.
- `docs/audits/2026-10-26-informed-spike.md` — the bare/informed numbers.
- `docs/specs/2026-10-25-duplicate-card-identity.md` — D1–D35.
- `docs/specs/2026-10-25-state-format.md` — F1–F10.
- `src/ledger.ts`, `src/census.ts`, `src/events.ts`, `src/lowering.ts`.
- The froslass fixture and the placed-counter template.

## Fix 1 — infer the defender from the attack context

### The defect

For `blog_loc_player_placed_dc` / `_single_dc`, the export puts the actor’s
player name into the `cardName` slot **and** the `targetPlayerName` slot. The
card is on the other side. The parser is faithful; no parser change is correct.

### The behavior

- Track the side of the most recent `attack` event while walking the stream.
- When a `counterDamage` event is under an attack and its target side equals the
  attack’s source side, the intended target is the **other** side.
- Apply the counters to that side’s group. Keep the event itself as printed; add
  a diagnostic (`DefenderInferred` or similar) so the correction is visible.
- If there is no recent attack, or the target side is not the attack’s source
  side, leave the current behavior.
- Do not flip every same-name target. The rule is contextual to placed counters
  under an attack; a genuine self-target must not be inverted.
- If both sides have the card, the attack context resolves it — apply to the
  other side, not the actor’s.

### Acceptance

- The froslass fixture’s placed-counter lines hit cdierkens’s Slowpoke, not
  TSLAUJ’s nonexistent one.
- A synthetic self-target under an attack stays on the actor’s side (the rule
  only flips when the printed target side is the actor and the template is a
  placed-counter line).
- The corpus `KnockoutUnproven` count falls, and the turn-boundary rate rises.
  Record both; do not assert a target number before measuring.

## Fix 2 — carry the source zone on moves

### The defect

`discarded_from_board` and `discarded_from_hand` are distinct template keys with
identical text. The lowered `moveCard` currently drops that distinction, so the
ledger cannot tell whether a board body left. It keeps the body on every
hidden-zone move, which is conservative but creates phantom bodies and
`BenchOverflow` warnings.

### The behavior

- Add a source to `MoveCardEvent`: `"board" | "hand" | "hidden" | null`.
  - `discarded_from_board` → `"board"`.
  - `discarded_from_hand` → `"hand"`.
  - `move_to_*`, `shuffled_*`, `move_on_top_deck`, `move_to_bottom_deck` →
    `"hidden"` or `null` (unknown).
- The ledger removes a board body only when the source is `"board"`.
  - `"hand"` never removes a board body.
  - `null` keeps the current conservative behavior: do not remove on no evidence.
- Do not guess the Night Stretcher case. If the template does not state the
  source, it stays unknown until card-effect data or a parser distinction exists.

### Acceptance

- A `discarded_from_board` line removes the body; a `discarded_from_hand` line
  does not.
- An unknown source leaves the body and does not create a false departure.
- The corpus `BenchOverflow` count falls; the turn-boundary rate is re-measured.

## Measure, then decide

Run the same 411 logs, bare and informed:

```sh
cd ../pokedojo.pro
pnpm exec tsx scripts/audit-battle-log-census.mjs --limit=411 --informed
```

Report:

- turn-boundary confirmed boards (primary);
- confirmed identity groups;
- never-confirmed logs;
- `unexecutable` (must stay zero);
- `KnockoutUnproven`;
- `BenchOverflow`.

If turn-boundary boards reach ~80%, the next task is packaging the oracle. If
they do not, the next task is the correlated solver, not more card data. If the
solver still does not reach it, the product answer is the group view.

## Out of scope

- The full correlated solver (D3/D16/D25).
- A card-data package or any data redistribution.
- Parser or template changes.
- A UI change.
- Changing the per-log headline definition.

## Traps already paid for

- The parser is faithful to the printed line. `TSLAUJ` in a `cardName` slot is an
  export defect, not a parse defect.
- Do not flip a same-name target without the attack context; self-targets exist.
- Do not remove a body on a move whose source is unknown.
- No raw corpus text in any output. Aggregates only.
- The HP oracle is a seam, not a fix: it moved the group rate 2.4 points and the
  board rate 3.3 points, and exposed more unproven knockouts.
