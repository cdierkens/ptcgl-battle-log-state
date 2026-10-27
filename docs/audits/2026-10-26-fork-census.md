# Audit: the first fork census

Date: 2026-10-26
Scope: slice 2 — the board ledger and the fork census
Solver: `@dierkens.dev/ptcgl-battle-log-state` at `064ac66` (0.1.0 plus the
unreleased ledger, census, and lowering fixes). Later commits to this note are
documentation only.
Corpus: 411 games across 5 workspaces, Firestore `workspaces/*/games/*.rawLog`

## Method

Read-only. `pokedojo.pro/scripts/audit-battle-log-census.mjs` walks every
workspace's `games` subcollection, runs `detectBattleLogLanguage` →
`parseBattleLog` → `lower` → `census`, and prints counts. It writes nothing, and
no battle log leaves Firestore: the report contains counts and rates, never text.
The same aggregation runs over the four committed fixtures via
`pnpm run census:fixtures`, so the method is reproducible without the corpus.

411 games in about 28 seconds in one process, sequentially.

## Headline

**81.0% of executable logs never confirm a board** (332/410, 95% Wilson
76.9–84.5). The census is a bare-mode **upper bound**: no card data, no
backtracking, and cross-group correlation is dropped when a body leaves a group.
The true bare rate is lower; the informed rate is unmeasured.

| Figure | Meaning | Result |
|---|---|---|
| **Never confirmed** | a live group still renders ≥2 pictures at the final prefix | **332/410 = 81.0%** (76.9–84.5) |
| Ever divergent | a fork occurred at any point | 351/410 = 85.6% (81.9–88.7) |
| Confirmed late | forked, but every group collapsed before the end | 19/410 = 4.6% (3.0–7.1) |

The three figures partition the executable logs: 81.0% never confirmed, 4.6%
confirmed late, and 14.4% never forked at all. In bare mode, rarely-sure is the
common case, not a small residue.

Excluding the 33 logs that hit the variant cap (all of them never-confirmed),
**299/377 = 79.3%** (74.9–83.1). Saturation is a frontier limit, not a log fact;
the cap is reported separately rather than hidden in the headline.

### How to read 81%

The headline is **per log**, not per group. At the final prefix, **730 of 3,127
live groups are divergent (23.3%)**; the other 76.7% are confirmed. An executable
log has about 7.6 live groups on average, so one residual group is enough to fail
the headline.

| | |
|---|---|
| live groups at the final prefix | 3,127 |
| divergent live groups | 730 (23.3%) |
| divergent live groups with one member | 348 (47.7% of divergent) |
| never-confirmed logs with exactly one divergent group | 100 (30.1% of never-confirmed) |
| never-confirmed logs with more than one | 232 (69.9%) |

The singleton number is the late-split shape: the body is known, but the damage
or attachments it inherited from an earlier group are not. That is still a
different picture, so it counts, but it is not "we do not know which card this
is."

Divergence is carried by damage (518 groups), attachments (394), and the
evolution stack (6); the counts are dimension-wise and overlap.

The four fixtures are 4/4 never confirmed, 23 fork episodes across 75 groups. The
froslass worked example stays a fork: the Slowpoke/Slowking split is exactly the
ambiguity card data collapses, and bare mode must not.

## Unexecutable is a gate, and it is zero

| | |
|---|---|
| logs scanned | 411 |
| parsed | 411 |
| lowered | 410 (1 log has no turn header — the F4 of the coverage audit) |
| executable | 410 |
| **unexecutable** | **0** |

The gate was 29/410 before the ledger resolved a client-export defect. The corpus
contains 2,438 counter placements that name the **acting player's** side, not the
target's (`… put damage counters on <actor>'s <card>` while the card is on the
other side). The game has two sides and the card is only on the other one, so the
target is forced by elimination. The ledger resolves it, emits a `SideMismatch`
diagnostic, and counts the correction instead of treating the log as corrupt.
Without that, 29 logs had an undefined event and the audit was untrustworthy
under D32.

## Cost

| | |
|---|---|
| groups censused (including ones that left) | 6,185 |
| fork episodes | 1,243 |
| live groups at the final prefix | 3,127 |
| divergent groups at the final prefix | 730 (23.3%) |
| largest variant set | 4,096 (the cap) |
| logs at the cap | 33 (8.0%) |

The frontier is the cost, not the log length. A 4,096-variant cap keeps a
pathological group from dominating the run; 33 logs hit it and are counted as
never-confirmed, which is conservative for an upper bound.

## Diagnostics

| code | count | what it is |
|---|---|---|
| `SideMismatch` | 2,438 | client export names the actor's side for placed counters; resolved by elimination |
| `SideAmbiguous` | 1,746 | the card is on both sides; the ledger uses the side the log named |
| `KnockoutUnproven` | 413 | no tracked body carried enough damage to explain the knockout; an effect KO, damage lost to a side bug, or a gap |
| `BenchOverflow` | 167 | the board is over 5 Bench bodies; a move to a hidden zone has no source, so a body may have stayed |
| `UnknownGroup` | 126 | a named card is not on the board (a Trainer, a body that left, or a card the ledger never saw enter) |
| `HealOverflow` | 109 | healing or counter movement exceeds tracked damage |
| `Saturated` | 33 | a group hit the variant cap and is frozen divergent |
| `AttachmentMismatch` | 9 | a discard list matches no possible body's pile |
| `PrizeOverflow` | 2 | more Prize cards taken than the six-card pool |

None of these is an error. The unexecutable gate is what separates a defect from
a modelling gap, and it is zero.

`KnockoutUnproven` matters for reading the headline: 413 knockouts (about 23% of
the 1,811 in the coverage audit) had no tracked body carrying enough damage to
explain them. The ledger still removes a body — the game did knock something out —
but it cannot say which one, so the knockout prunes much less than it should.
Effect knockouts, damage lost to the side bug, and unmodelled sources all land
here. That is one more reason 81.0% is an upper bound.

`SideAmbiguous` is the mirror-match limitation: 1,746 events name a card that is
on both sides, and the per-group model cannot fork across sides. The ledger uses
the side the log named and says so. A full cross-side scenario is part of the
same format gap as F3.

## Findings

### F1 — Bare mode does not support "most logs collapse"

The design's hypothesis was that most logs settle to one board and a small
fraction never do. In bare mode the opposite holds: 85.6% fork, and 81.0% never
collapse. The gap is the price of shipping no card database:

- a damage line carries no zone, so a name present in both the Active Spot and
  the Bench is ambiguous even when the attack could only hit one of them;
- an attach line names the card, not the body, so two copies are ambiguous until
  a discard list or a knockout separates them;
- an evolution is ambiguous until the log proves which body carried what.

Card data collapses all three: HP bounds identify which body could have died,
and attack targetability prunes the Bench. The informed run is the next
measurement, and its delta decides whether the zero-dependency posture is
affordable (D33). This audit cannot quote the delta.

### F2 — The group key is `(side, card name)`, not `(side, card name, zone)`

D1 keys groups by zone, but a damage line does not carry one. Assigning a
damage line to one zone key would invent the zone the spec says the log does not
give. The ledger groups by `(side, card name)` and carries `zone` on each body;
the document's `IdentityGroup` already has no zone field. This keeps the group's
candidates checkable and is the only form the current format can hold. D1's
wording should be amended.

### F3 — A split is not representable in `ptcgl-state/1`

F5 requires every candidate of a group to carry the same multiset. That covers
permutations inside one group; it cannot express a body leaving a group (an
evolution, a retreat among same-name copies, or a knockout) where the surviving
groups' multisets are correlated. The froslass example is the proof: after
`Slowpoke → Slowking`, "the Slowking has 30" and "the Slowpoke has 30" are two
documents the format cannot write, because each slot outside a group carries its
own damage. The census measures the ambiguity; `reconstruct()` cannot emit it
until the format grows a cross-group scenario. Raised, not worked around.

### F4 — A move to a hidden zone has no source zone

A card-recovery Trainer prints `moved <card> to hand` whether the card came from
the discard or the board. `moveCard` records the destination, not the source.
Removing a board body on that line deletes the active Pokémon on no evidence, so
the ledger keeps it; that over-counts (167 `BenchOverflow` warnings) and can only
over-report divergence. The event should carry a source zone, or the lowering
should distinguish "from the board" from "from a hidden zone", in a follow-up.

### F5 — Two lowering bugs the ledger exposed

- **Switch placeholders were reversed.** `blog_loc_switched_active`'s
  `targetCardName` is the card that becomes Active and `sourceCardName` is the
  one that leaves. The lowering had them the other way round, so the ledger moved
  the wrong bodies.
- **Count phrases swallowed card lists.** `move_to_*`, `shuffled_*`, and
  `discarded_*` lines carry `2 cards` in the placeholder and the real names in
  the `•` list. Taking the phrase as the card left bodies on the board under a
  phantom name. The lowering now emits one `moveCard` per named card.

Both are fixed with tests. Neither is a parser change: the parser was faithful
to the templates.

### F6 — The corpus is single-locale

All 411 logs detect as `en`. The localized card-list splitter is still
unvalidated, and this audit cannot close it. Non-English logs remain the gap only
a non-English player can close.

### F7 — One log has no turn header

The 1 lower failure is the same truncated export as the coverage audit's F4. It
is 1 in 411; refusing it is correct, and the tracker should surface it as "could
not reconstruct" rather than as a crash.

## Deferred by design

- **D25's suffix viability.** The census checks local executability only: a
  variant that runs the next line survives. It does not re-check the remaining
  suffix, because that is the full solver's job and this slice is explicitly "no
  DFS, no backtracking". `unexecutable` here means "undefined on the next line",
  not "invalid to the end".
- **Prize reconciliation.** Prize counts are tracked and overflow-checked, but
  `took N Prize cards` is not reconciled against the knockouts' values. Without
  card data (a prize value per name) or reliable multi-KO attribution, that would
  be a guess.
- **Per-template-key stratification.** The census counts logs, not template keys,
  and all 411 logs are `en`. A key-level view needs the solver's constraint trace
  (F9), which v1 defers.
- **Cross-log HP convergence.** HP is a per-body interval inside one log. Bounds
  are not aggregated into a card-property table across the corpus; that is the
  informed run's job.
- **Cross-side ambiguity.** When both sides have a card of the same name, the
  ledger uses the side the log named. It cannot represent a fork between the two
  sides, and it does not invent one.

## What this audit does not answer

- **The informed delta.** No card HP or targetability was read. That run needs
  PokeDojo's `cards` read model and an adapter; it is the number that decides the
  zero-dependency posture.
- **The solver's residue.** The census drops cross-group correlation on a split.
  The full solver's never-confirmed rate lands between this upper bound and zero;
  the gap is what the solver is worth.
- **Per-deck or per-archetype rates.** Not stratified; `n` per group is too small
  to support them here.
- **Locale variation.** The corpus is `en` only.

## Reproduce

```sh
# fixtures, committed and reviewable
pnpm run census:fixtures

# corpus, read-only, aggregates only
cd ../pokedojo.pro
pnpm exec tsx scripts/audit-battle-log-census.mjs --limit=411
```

Every rate is an observed proportion with `n` and a 95% Wilson interval. This is
a census of one corpus, not a sampled estimate of the player base.

## Follow-up: the informed spike

The HP interval was corrected after this run (`min` is inclusive; a survival at
damage `d` sets `d + 1`). Re-running the bare census on the corrected code gives
333/410 = 81.2% and 300/377 unsaturated; the difference is one log, and the
conclusion is unchanged.

[The informed spike](2026-10-26-informed-spike.md) adds card HP and attack
targetability. It reaches **79.2% of identity groups** but only **58.1% of
turn-boundary boards**, so card data alone does not make the board ~80%
solvable. The remaining gap is the side bug, hidden-zone moves, unproven
knockouts, and cross-group correlation — not more card fields. See
[the export-defect findings](2026-10-27-export-defect-and-solvability.md) for the
template evidence and the fix order.
