# Findings: the export defect and the solvability ceiling

Date: 2026-10-27
Scope: why the informed census still does not reach 80% of boards, the export
defect behind part of it, and the fixes that follow
Status: findings and a proposed order. The fixes are **not approved**; the specs
in `docs/specs/` still bind.
Related: [the first fork census](2026-10-26-fork-census.md),
[the informed spike](2026-10-26-informed-spike.md)

## Summary

1. The game’s export puts the **actor’s player name into a `cardName`
   placeholder** for placed damage counters, and repeats that actor in the
   `targetPlayerName` placeholder. It is not a parser bug. 3,180 counter
   placements in 411 logs are affected.
2. Card HP plus attack targetability reaches **79.2% of identity groups** but
   only **58.1% of turn-boundary boards**. The 80% bar depends on which unit is
   meant; more card data is not what closes the gap.
3. The next work is structural: infer the defender from the attack context,
   carry a source zone on moves, and only then build the correlated solver. Do
   not package card data until the board rate is acceptable.

## The export defect

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

TSLAUJ is a player, not a card. The Slowpoke is cdierkens’s. The line is wrong
in two separable ways:

- **The `cardName` slot is a player name.** The template is card-shaped; the
  game filled it with the actor.
- **The `targetPlayerName` slot repeats the actor.** The intended target is the
  defender, which is the other side.

The parser is faithful to the printed line. No parser change recovers the
intended target; only the board and the surrounding attack can.

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
already flips those by elimination. The 754 `SideAmbiguous` placements name a
card that exists on both sides, so the board cannot tell which copy was meant.
Together, **3,180 placed-counter events are affected**.

The other 992 `SideAmbiguous` events are mirror matches (attach, damage,
knockout, detach): the card is on both sides and the log names one. They are not
the same export defect, but they have the same modelling consequence — a
per-group model cannot branch across sides.

### What not to do

- **Do not change the parser.** The template and the line are what they are.
- **Do not flip every same-name target.** A genuine self-target would be
  inverted. Use the attack context, not the placeholder.
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

### 1. Infer the defender from the attack context

**Behavior.** A placed-counter line is a sub-entry of an attack. The attack’s
source side is the actor; the target is the other side. The ledger tracks the
last attack’s side and uses it when a counter placement names the actor as the
target. The event remains in the record exactly as printed; the inference is
reported.

**Why it is safe.** The rule is contextual, not a blanket flip: it applies only
to counter placements under an attack. A genuine self-target would need its own
template or a different context.

**Expected effect.** Corrects most of the 3,180 affected placements, reduces
unexplained knockouts, and removes forks caused by damage landing on the wrong
body. Measure; do not assume.

**Codebase.** `ptcgl-battle-log-state` — ledger and, if needed, a lowering flag
that the `cardName` value resolved to a player.

### 2. Carry the source zone on moves

**Behavior.** A move to hand/deck/discard must say whether the card came from
the board, the hand, or an unknown zone. `discarded_from_board` and
`discarded_from_hand` are distinct template keys with identical text; the
lowering can carry that distinction into the event. A board-sourced move leaves;
a hand-sourced move does not. An unknown source keeps the body rather than
deleting it on no evidence.

**Why it is partial.** The `move_to_*` and `shuffled_*` keys do not say where the
card came from. The Night Stretcher-style “discard to hand” case stays unknown
until card-effect data or a parser distinction supplies the source.

**Expected effect.** Removes phantom bodies the log can prove left; reduces the
167 `BenchOverflow` warnings and the forks they create.

**Codebase.** `ptcgl-battle-log-state` — lowering and event record; the ledger
uses the new field.

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

1. Fix the side inference and the source zone.
2. Re-run the same 411 logs and the same units.
3. **Primary acceptance:** turn-boundary confirmed boards.
4. **Secondary:** confirmed groups, never-confirmed logs, `KnockoutUnproven`.
5. **Gate:** `unexecutable` stays at zero.
6. If the board rate is still below 80%, build the correlated solver.
7. If it is still below 80% after that, ship the group view, not a claimed board.

The per-group number is already 79.2%. The board number is 58.1%. The next two
fixes are cheap enough to measure before committing to the solver.

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
