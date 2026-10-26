# Implementation prompt — slice 2: the ledger and the fork census

## Role

You are implementing slice 2 of `@dierkens.dev/ptcgl-battle-log-state`. The
contract, the lowering pass and the document validator are shipped. This slice
builds the board ledger and the **fork census** — the first measurement of the
question the whole package exists to answer: *how often can a battle log not
confirm a board?*

Do not relitigate the design. `docs/specs/` is approved; where this prompt and a
spec disagree, the spec wins and the disagreement is a finding to raise, not a
decision to take.

## State of the repo

- `@dierkens.dev/ptcgl-battle-log-state@0.1.0` is published (provenance attached)
  from tag `v0.1.0`. `main` is green.
- One pending changeset (`withdraw-breakdown-check`, patch) — it is unreleased and
  will roll into the next cut.
- Runtime dependency: `@dierkens.dev/ptcgl-battle-log-parser@1.2.0`, pinned
  exactly on purpose (the lowering table is total over its key set).
- Lowering: 66 keys mapped, 162 ignored with a reason, `unhandled` fails the
  build. Verified over 411 real games: 0 parse failures, 0 unhandled keys.
- 48 tests, `pnpm run verify` is the gate.

## Read first

- `AGENTS.md`, `GLOSSARY.md`
- `docs/specs/2026-10-25-duplicate-card-identity.md` — the design. Decisions
  D1–D35 are binding.
- `docs/specs/2026-10-25-state-format.md` — the document shape this slice starts
  producing. F1–F10.
- `docs/adr/0001-tag-triggered-oidc-releases.md`
- `docs/audits/2026-10-26-corpus-coverage.md` — what the corpus contains and the
  three traps already paid for.
- `src/lowering.ts`, `src/events.ts`, `src/types.ts`, `src/document.ts`
- In `../ptcgl-battle-log-parser`: `docs/adr/0006-apostrophe-equivalence.md` (why
  matching is what it is).

## What to build

### 1. The ledger

A forward pass over `GameEvent[]` that maintains board state. Follow the specs
literally:

- **Slots and groups.** A Pokémon in play is a slot with `{name, zone, damage,
  attachments}`. Damage lands on an *identity group* — `(side, cardName, zone)` —
  not on a slot, until an event forces a split (D1, D2). Store the group's damage
  as a multiset.
- **Resolution by elimination**, not by choosing: knockout (needs HP), evolve and
  devolve, retreat / promote / switch, move-to-deck/discard/hand/prizes/lost,
  heal, move-counters, and the detach that follows a knockout (D14).
- **The attachment ledger.** Energy and Tools are typed, counted and named at both
  ends. A knockout's discard list names one body's pile exactly; the complement
  over the surviving bodies is forced (D14). This is the strongest evidence in
  the log and the reason the ledger exists.
- **Learnt properties.** HP is an interval per `(name, printing)`, tightened only
  by proof: a knockout at cumulative `d` gives `HP ≤ d`, a survival at `d` gives
  `HP > d` (D4, D4a). Targetability is soft until observed. Never assume a
  property to make progress.
- **Hidden zones are counts plus known cards**, never groups (D28).
- **Deferral.** Do not commit a group to one slot. Keep its candidate set open and
  re-check it on every transition (D16).

### 2. The fork census

This is **not** the solver. No DFS, no backtracking, no display hypothesis.

- A **fork** is the moment a group's candidate set first exceeds one.
- The group **collapses** when filtering against later events reduces it to one;
  `resolvedAt` records that prefix.
- A group still plural at the final prefix is **never confirmed**.
- Report per log: fork count, never-confirmed groups, and the prefix span each
  group was plural for.

Deliver the three figures the audit promised (D30): **never confirmed**
(headline), **ever divergent**, **confirmed late** — and remember D31: confirmed
means one *render-distinct* board, not one internal world.

### 3. Acceptance

- `lower()` already collapses restatements and tags every event with
  `at: {phaseIndex, turn, line}`, so the census can point at lines.
- Fixtures first: the four vendored logs must produce a stable, explainable
  census. Add assertions for any fork they contain (beedrill's `Slowpoke ×3`,
  froslass's `Slowpoke ×2` + KO, dipplin's `Applin → Dipplin` chain).
- Then the corpus: `pnpm exec tsx scripts/audit-battle-log-coverage.mjs` in
  `../pokedojo.pro` is the pattern (read-only, aggregates only). Extend that
  script or add a sibling; **no raw log text leaves the machine, and none is
  printed**.
- Report `n` and a 95% Wilson interval. Never-confirmed is the headline (D34).
- Write the result to a new dated note in `docs/audits/`. A census without `n` is
  an anecdote.

## Traps already paid for — do not re-derive

1. **Breakdowns are not arithmetic.** Two rules were tried and falsified by the
   same data (partials; duplicated component lines; legitimate 0-damage hits). It
   is carried as printed and asserted against nothing (D22, F3 withdrawn).
2. **`[cardName]` can hold a count phrase** (`5 cards`). The lowering records names
   verbatim and never interprets them (D35). Deciding whether a name is a card is
   the ledger's job, and "unmatched name" is the honest answer.
3. **Restatements vs secondary damage.** A sub-entry attack repeating a main-entry
   attack is the confirmation of it; `secondary_damage` has no attacker and is
   never collapsed — two identical `Weedle took 110 damage` lines are two cards.
4. **The AST carries no line numbers.** The lowering numbers lines against the raw
   text; use `event.at.line` and never re-derive it.
5. **Sides are deduced, not guessed.** One known player plus a second name is
   deduction (the game has two players); a third name is a diagnostic.
6. **A golden cannot catch a misparse.** The parser bug this project found was
   invisible because the golden was generated from the wrong parse. Prefer
   property assertions over snapshots.

## Environment notes

- `pnpm run verify` before every commit. `pnpm run audit:fixtures` runs the
  coverage report over the four vendored logs.
- The corpus lives in PokeDojo's Firestore: `workspaces/{uid}/games/{uid}.rawLog`.
  `pnpm exec tsx scripts/audit-battle-log-coverage.mjs --limit=N` in
  `../pokedojo.pro` reads it. That script imports this package's `dist/`, so
  `pnpm run build` first.
- **`pnpm-workspace.yaml` carries a deliberate exemption**:
  `@dierkens.dev/ptcgl-battle-log-parser@1.2.0` is excluded from pnpm's
  release-age policy because CI verifies the lockfile and the release was hours
  old when consumed. Delete that line once 1.2.0 is a day old — it is a grace
  period, not a policy hole.
- Commits are conventional; releases are `pnpm changeset` → `pnpm run version` →
  tag, via OIDC.

## Open questions to settle before coding

1. **Where does the ledger live?** `src/ledger.ts` with the census as a mode, or
   two modules? It is the largest thing in the package; prefer two files over one
   that does both (Divergent Change).
2. **Can the census run without HP?** Knockouts are the main resolution event and
   need HP. The bare run (bounds only) will resolve less, and that gap *is* the
   zero-dependency cost the audit promised to measure (D33). Decide whether the
   census ships two modes now or one mode plus a follow-up.
3. **What counts as a fork worth reporting** — every group that ever exceeded one
   candidate, or only groups whose plurality was render-distinct? D31 says the
   headline is render-distinct; the raw count is a debug metric.

## Out of scope

- The full solver, backtracking, and any UI.
- Schemas (`schemas/`, F10) — they ship when the document shape is exercised by
  real output, not before.
- `reconstruct()`, the `ptcgl-events/1` record, `recordHash` (F2, F6).
- Card data of any kind. Learnt bounds only.
