# Implementation prompt — stop guessing a placed counter's side

## Role

You are implementing fix 1 in
[the solvability findings](../audits/2026-10-27-export-defect-and-solvability.md)
(read its Corrections section first; an earlier version of this brief had two
fixes, and both rested on a wrong model of the line).
The goal is to move the **turn-boundary board** confirmation rate. The
per-group rate is already 79.2%; the board rate is 58.1%, and card data alone did
not move it to 80%.

Do not build the full solver in this task. Do not package card data. Do not
change the parser.

## Read first

- `docs/audits/2026-10-27-export-defect-and-solvability.md` — the findings, the
  corrections and the exact counts.
- The parser README's "What a line does not say" — what the placed-counter
  placeholders hold.
- `docs/audits/2026-10-26-informed-spike.md` — the bare/informed numbers.
- `docs/specs/2026-10-25-duplicate-card-identity.md` — D1–D35.
- `docs/specs/2026-10-25-state-format.md` — F1–F10.
- `src/ledger.ts`, `src/census.ts`, `src/events.ts`, `src/lowering.ts`.
- The froslass fixture and the placed-counter template.

## Fix 1 — treat a placed counter's side as unknown

### The model

For `blog_loc_player_placed_dc` / `_single_dc`, the client fills `cardName` with
the acting player and `targetPlayerName` with the owner of the card whose effect
placed the counters. The line never names the target's owner. The parser is
faithful; no parser change is correct.

### The behavior

- For a `counterDamage` event, resolve the target by the board, not the printed
  side:
  - the card is on one side only → that side (elimination, as today);
  - the card is on both sides → a cross-side divergence, not the printed side;
  - the card is on neither → `UnknownGroup`, as today.
- Keep the event itself as printed; report the resolution.
- Other events (`attach`, `damage`, `knockout`, `detach`) do name the owner:
  leave their `SideAmbiguous` handling alone.
- Do **not** flip to the defender or use the attack context to pick a side:
  the printed side is the source owner on almost every line, and genuine
  own-side placements exist.

### Acceptance

- The froslass fixture's placed-counter lines hit cdierkens's Slowpoke, by
  elimination (unchanged).
- A synthetic placement on a name both sides have does not land on the printed
  side; it is carried as divergent.
- `unexecutable` stays zero. Record the turn-boundary rate and
  `KnockoutUnproven` before and after; the rate may fall, because some boards
  were confirmed on a guess. Do not assert a target number before measuring.

## Not a fix — a source zone on moves

An earlier version asked the lowering to carry `"board"` / `"hand"` from the
discard keys. That is impossible: the two keys print identical text, parser 2.0
reports both as candidates with a `null` key, and `_hand` covers hand **or deck**.
Do not add a source field that the line cannot fill.

## Measure, then decide

Run the same 411 logs, bare and informed:

```sh
cd ../pokedojo.pro
pnpm exec tsx scripts/audit-battle-log-census.mjs --limit=411 --informed
```

Report:

- turn-boundary confirmed boards (primary; may fall);
- confirmed identity groups;
- never-confirmed logs;
- `unexecutable` (must stay zero);
- `KnockoutUnproven`;
- `BenchOverflow` (unchanged expected; it is not addressed here).

If turn-boundary boards reach ~80%, the next task is packaging the oracle. If
they do not, the next task is the correlated solver, not more card data. If the
solver still does not reach it, the product answer is the group view.

## Out of scope

- The full correlated solver (D3/D16/D25).
- A card-data package or any data redistribution.
- Parser or template changes.
- A source zone on moves.
- A UI change.
- Changing the per-log headline definition.

## Traps already paid for

- The parser is faithful to the printed line. `TSLAUJ` in a `cardName` slot is
  the client's design, not an export or parse defect.
- Do not flip a placed counter to the defender; own-side placements exist, and
  the printed side is the source owner, not the target's.
- Do not remove a body on a move whose source is unknown — and a discard's
  source is always unknown from the line.
- No raw corpus text in any output. Aggregates only.
- The HP oracle is a seam, not a fix: it moved the group rate 2.4 points and the
  board rate 3.3 points, and exposed more unproven knockouts.
