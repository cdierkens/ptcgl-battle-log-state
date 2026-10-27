# Findings: the export defect and the solvability ceiling

Date: 2026-10-27
Scope: why the informed census still does not reach 80% of boards, the export
defect behind part of it, and the fixes that follow
Status: findings and a proposed order. The fixes are **not approved**; the specs
in `docs/specs/` still bind.
Related: [the first fork census](2026-10-26-fork-census.md),
[the informed spike](2026-10-26-informed-spike.md)

## Corrections (2026-10-27, after review)

An audit of this document against the stored corpus and the game client's
battle-log code found the export-defect model wrong. The counts stand; the
explanation and two fixes do not:

- **It is not an export defect.** The client fills the placed-counter
  `[cardName]` slot with the acting player by design, and `[targetPlayerName]`
  with the owner of the card whose effect placed the counters (falling back to
  the target's owner only when that is unknown). The line never names the
  target's owner. See the parser README, "What a line does not say".
- **Fix 1 as written would invert correct placements.** `[targetPlayerName]` is
  the source owner on almost every line, so "flip when it names the actor"
  flips nearly all of them, including genuine own-side placements. Rewritten
  below.
- **Fix 2 as written is impossible.** `discarded_from_board` and
  `discarded_from_hand` print identical text; no parser can tell them apart.
  Since parser 2.0 the key is `null` with both candidates. `_hand` also covers
  discards from the deck. Rewritten below.
- **Scope of the counts.** The placed-counter events come from the 297 of the
  411 logs that contain placed-counter lines.

## Summary

1. A placed-counter line names the **acting player** in its `cardName`
   placeholder and the **effect source's owner** in `targetPlayerName`, by the
   client's design. It never names the target's owner. 3,180 counter
   placements (in the 297 logs that have any) needed the ledger to correct or
   doubt the printed side.
2. Card HP plus attack targetability reaches **79.2% of identity groups** but
   only **58.1% of turn-boundary boards**. The 80% bar depends on which unit is
   meant; more card data is not what closes the gap.
3. The next work is structural: stop trusting the printed side of a placed
   counter, and only then build the correlated solver. A source zone on
   discards is not recoverable from the line. Do
   not package card data until the board rate is acceptable.

## The placed-counter line

### What the fixture prints

From the committed `slowking-vs-froslass-mill.log`:

```text
TSLAUJ put 2 damage counters on TSLAUJ's Slowpoke.
```

The template is:

```text
[cardName] put [numDamageCounters] damage counters on [targetPlayerName]'s [targetPokemonCardName].
```

The parser matches `blog_loc_player_placed_dc` and fills it faithfully:

```text
cardName                 TSLAUJ
numDamageCounters        2
targetPlayerName         TSLAUJ
targetPokemonCardName    Slowpoke
```

TSLAUJ is a player, not a card. The Slowpoke is cdierkens’s. The line is not
wrong; its placeholder names mislead:

- **The `cardName` slot is the acting player**, by the client's design: 5,370 of
  5,370 placed-counter lines.
- **The `targetPlayerName` slot is the owner of the effect source**, not of the
  target. It held the owner of the most recent `used` line in the phase in 5,192
  of the 5,268 lines that had one. Here TSLAUJ's attack placed the counters, so
  the line says TSLAUJ's.

The parser is faithful to the printed line. No parser change recovers the
target's owner, because the line does not carry it; only the board can.

### How often

`SideMismatch` and `SideAmbiguous` diagnostics correlated to the event on the
same line, over the same 411 logs:

| diagnostic | event on the line | count |
|---|---|---|
| `SideMismatch` | `counterDamage` | **2,426** |
| `SideAmbiguous` | `counterDamage` | **754** |
| `SideMismatch` | `detach` | 12 |
| `SideAmbiguous` | `attach` | 433 |
| `SideAmbiguous` | `damage` | 274 |
| `SideAmbiguous` | `knockout` | 149 |
| `SideAmbiguous` | `detach` | 136 |

The 2,426 `SideMismatch` placements name a side that has no such card; the ledger
resolves those by elimination, which is a deduction. The 754 `SideAmbiguous`
placements name a card that exists on both sides; the ledger currently applies
them to the printed side, which for a placed counter is the source owner's — a
guess. Together, **3,180 placed-counter events are affected**.

The other 992 `SideAmbiguous` events are mirror matches (attach, damage,
knockout, detach): the card is on both sides and the log names one. Those lines
do name the owner, so they are a different problem with the same modelling
consequence — a per-group model cannot branch across sides.

### What not to do

- **Do not change the parser.** The template and the line are what they are.
- **Do not flip to the defender.** The printed side is the source owner on
  almost every line, so a flip inverts every genuine own-side placement. The
  attack context does not say which side the counters landed on either.
- **Do not silently rewrite the record.** Keep what the log printed and record
  the inference; a reader must be able to see the correction.

## The 80% question

The same 410 executable logs, bare vs informed (card HP and attack
targetability):

| unit | bare | informed |
|---|---|---|
| Identity groups confirmed | 76.8% | **79.2%** |
| Turn-boundary boards confirmed | 54.8% | **58.1%** |
| All prefixes confirmed | 36.8% | 42.2% |
| Logs fully confirmed | 19.0% | **23.9%** |
| Logs never confirmed | 81.2% | 76.1% |

“80% of states solvable” is not one number:

- **Per identity group:** 79.2%, essentially the bar.
- **Per turn-boundary board:** 58.1%, 22 points short.
- **Per log:** 23.9%, far.

The board unit is the one a viewer experiences. On that unit, card data alone
does not make the product usable.

### What the oracle bought

- Never-confirmed logs: 81.2% → 76.1% (−5.1 points).
- Confirmed groups: 76.8% → 79.2% (+2.4).
- Turn-boundary boards: 54.8% → 58.1% (+3.3).
- Saturated logs: 33 → 22.
- `KnockoutUnproven`: 249 → 535. Card HP **exposed** knockouts that tracked
  damage cannot explain; it did not create them.

## The fixes

### 1. Treat a placed counter's side as unknown

**Behavior.** The printed side of a placed counter is the source owner, so the
ledger resolves the target by the board alone: the side that has the card when
only one does (elimination, as today), and both sides when both do — a
cross-side divergence, never the printed side. The event remains in the record
exactly as printed; the resolution is reported.

**Why it is safe.** It only removes a guess. Elimination is unchanged, and the
754 ambiguous placements stop landing on a side the line never named.

**Expected effect.** Fewer confident-but-wrong boards; possibly a *lower*
confirmed rate, because some boards were confirmed on a guess. Measure; do not
assume. A cross-side divergence needs the correlated solver (fix 3) or a group
view to be useful.

**Codebase.** `ptcgl-battle-log-state` — ledger.

### 2. A source zone on moves — not from the line

**Behavior.** A move to hand/deck/discard would ideally say whether the card
came from the board. The line cannot: `discarded_from_board` and
`discarded_from_hand` print identical text (parser 2.0 reports both as
candidates), `_hand` covers own hand or deck, and the `move_to_*` and
`shuffled_*` keys do not name a source. The client picks the discard key by the
card's real source zone, which the export does not print.

**What remains possible.** Evidence from the board: a discarded name that is on
the board and in no other line's reach can be reasoned about by the solver, not
by the lowering. An unknown source keeps the body rather than deleting it on no
evidence, as today.

**Expected effect.** None from the lowering. The 167 `BenchOverflow` warnings
are a solver problem.

**Codebase.** `ptcgl-battle-log-state` — solver, if anywhere.

### 3. The correlated solver

**Behavior.** The census drops cross-group correlation when a body leaves a
group. The solver keeps scenarios across groups, merges worlds that render
identically, and re-checks the open groups on every transition (the spec’s
D3/D16/D25). A late knockout can then collapse several groups at once.

**Expected effect.** The only fix for the 208 logs with multiple divergent
groups and the 288 single-body late-splits. It is also the expensive one: the
frontier can grow, and that cost is the reason the census exists.

**Codebase.** `ptcgl-battle-log-state` — a solver layer above the ledger.

### 4. Show the group, not a false board

**Behavior.** If the board rate still does not reach 80%, the product answer is
to render the identity group (“1 of 2”, damage as a multiset) instead of claiming
a single board. The state package already carries the group; the UI must not
flatten it.

**Codebase.** `ptcgl-battle-log-tracker` — board view. Not the state package.

## Card data packaging

Do **not** ship a card-data package yet. The oracle is necessary but not
sufficient; packaging it now would over-promise what the model can do.

When the board rate justifies it, there are two shapes:

1. **A builder, private artifact (preferred).** An MIT code package fetches,
   normalises, and compresses card data into a local artifact. No dataset is
   redistributed. The state package keeps only the `CardOracle` port.
2. **A data package.** TCGdex’s content is CC BY-SA 4.0 and the underlying card
   information is The Pokémon Company’s, so a redistributed dataset cannot be
   MIT. It would need attribution and share-alike, with a `NOTICE`.

Either way, the artifact is name-keyed, not set-number-keyed: HP per printing,
attack names and targetability, prize value, evolution edge. No images, no full
card text, compressed by name.

## Order and acceptance

1. Stop trusting the printed side of a placed counter (fix 1).
2. Re-run the same 411 logs and the same units.
3. **Primary acceptance:** turn-boundary confirmed boards.
4. **Secondary:** confirmed groups, never-confirmed logs, `KnockoutUnproven`.
5. **Gate:** `unexecutable` stays at zero.
6. If the board rate is still below 80%, build the correlated solver.
7. If it is still below 80% after that, ship the group view, not a claimed board.

The per-group number is already 79.2%. The board number is 58.1%. Fix 1 is cheap
enough to measure before committing to the solver; it may lower the rate by
removing guesses, which is the honest direction.

## Reproduce

```sh
# bare and informed over the corpus
cd ../pokedojo.pro
pnpm exec tsx scripts/audit-battle-log-census.mjs --limit=411
pnpm exec tsx scripts/audit-battle-log-census.mjs --limit=411 --informed

# fixtures
cd ../ptcgl-battle-log-state
pnpm run census:fixtures
```

All rates carry `n`; the informed spike carries Wilson intervals. No raw corpus
text is printed, and no card data is redistributed.
