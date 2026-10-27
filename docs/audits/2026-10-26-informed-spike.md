# Audit: does card data make the board solvable?

Date: 2026-10-26
Scope: informed spike — the `CardOracle` port with real card data
Solver: `@dierkens.dev/ptcgl-battle-log-state` at `8313276`
Corpus: 411 games across 5 workspaces, Firestore `workspaces/*/games/*.rawLog`
Card data: PokeDojo's `cards` collection, read-only; 254 names, 2,703 printings

See [the export-defect and solvability findings](2026-10-27-export-defect-and-solvability.md)
for the template analysis behind the side bug and the fix order.

## The question

The bare census left 81.2% of logs never confirmed and only a 36.8% confirmed
prefix rate. Before shipping a card-data package, answer one question: **does
card data get a board to ~80% solvable?** If it does not, the package is not the
next move.

This is the cheap version of the informed run: card HP, attack targetability,
and nothing else. It is not the full solver. Cross-group correlation is still
dropped on a split, and no suffix viability is checked.

## What the oracle supplied

- **HP per printing.** The log names a card, so a name maps to every printing and
  the body starts with `[min HP, max HP]`. Card HP makes an impossible knockout
  provable: a 30-damage hit cannot knock out a 60-HP body.
- **Attack targetability, from the attack text.** An attack that names the Bench
  (`Benched`, `1 of your opponent's Pokémon`, `each/all of your opponent's
  Pokémon`) can hit both zones. Everything else is Active-only, which is the
  game's default. Unknown stays `null` and never prunes.
- **Not used yet:** prize value and evolution edges are in the port but not yet
  wired into the ledger.

The oracle is a plain in-memory map built once per corpus run. Nothing is written,
and no card data is redistributed.

## Results

Bare is the same 410 executable logs; informed adds the oracle.

| | bare | informed | delta |
|---|---|---|---|
| Never confirmed (logs) | **333/410 = 81.2%** (77.2–84.7) | **312/410 = 76.1%** (71.7–80.0) | −5.1 pts |
| Ever divergent (logs) | 352/410 = 85.9% | 335/410 = 81.7% | −4.2 |
| Confirmed late (logs) | 19/410 = 4.6% | 23/410 = 5.6% | +1.0 |
| Divergent groups at end | 727/3,127 = 23.2% | 650/3,127 = 20.8% | −2.4 |
| **Confirmed groups** | **76.8%** | **79.2%** | **+2.4** |
| Confirmed prefixes | 36.8% | 42.2% | +5.4 |
| **Confirmed turn-boundary boards** | **54.8%** (868/1,583) | **58.1%** (919/1,583) | **+3.3** |
| Saturated logs | 33 | 22 | −11 |
| `KnockoutUnproven` | 249 | 535 | +286 |
| `TargetZoneUnreachable` | 0 | 2 | +2 |

## Verdict

**Not at 80% of boards.** The most favorable board measure — the turn boundary,
the state a viewer would stop on — moves from 54.8% to **58.1%**. The per-prefix
rate moves from 36.8% to 42.2%. The per-log fully-confirmed rate is 23.9%.

The one number that reaches the bar is **per-group**: **79.2%** of live identity
groups are confirmed. If "state" means "one card's damage/attachments," the
approach is essentially there. If it means "one board at a turn," it is not.

Card HP is not the missing piece. It bought about five points, and it *exposed*
more unproven knockouts (249 → 535): once a body's HP is known, damage that does
not explain the knockout becomes visible instead of being silently accepted.

## What is actually left

The residual is structural, not more card fields:

- **Attachments on identical bodies.** 396 groups differ in attachments. Card
  data does not say which copy received the tool or Energy. A knockout's discard
  list resolves some; the rest are genuinely in the log as a group.
- **The client's side bug.** 2,438 counter placements name the acting player's
  side; 1,746 more name a card that is on both sides. When both sides have the
  card, the ledger trusts the log's side. A per-group model cannot branch across
  sides, and card data does not help.
- **Unproven knockouts.** 535 have no tracked lethal body. Effect knockouts,
  damage lost to the side bug, and unmodelled sources all land there. The
  knockout prunes much less than it should.
- **Phantom bodies.** 167 `BenchOverflow` warnings come from moves to hidden
  zones with no source; the body stays on the board because removing it would be
  a guess.
- **Cross-group correlation.** The census drops it on a split. The 208 logs with
  more than one divergent group may collapse under the full solver; this census
  cannot show it.
- **Saturation.** 22 logs still hit the variant cap and are counted
  never-confirmed.

## What would close the gap

1. **Fix the side bug at the lowering.** A placed-counter line that names the
   actor for both sides is a known client pattern. Correcting it at the source
   would let 2,438 events hit the right body, reduce unproven knockouts, and
   remove several phantom forks.
2. **Carry a source zone on `moveCard`.** A move to hand/deck/discard that came
   from the discard must not remove a board body. This removes the 167 phantom
   bodies and the forks they create.
3. **Build the correlated solver.** The spec's D3/D16/D25: keep scenarios across
   groups, re-check the open groups on every transition, and validate the suffix.
   That is what can collapse the 208 multi-group logs and the 288 singleton
   late-splits.
4. **Only then package card data.** The oracle is necessary but not sufficient;
   shipping a data package now would over-promise what the model can do.

## Caveat on targetability

The Active-only rule is inferred from the absence of a Bench phrase in the
attack text. Two `TargetZoneUnreachable` warnings in 411 logs is a sign the
classifier is mostly consistent, not a proof. Any attack whose text hides a Bench
target would be wrongly pruned; the port keeps `null` for unknown, so the
fallback is conservative.

## Reproduce

```sh
# bare
cd ../pokedojo.pro
pnpm exec tsx scripts/audit-battle-log-census.mjs --limit=411

# informed: HP + attack targetability
pnpm exec tsx scripts/audit-battle-log-census.mjs --limit=411 --informed
```

Every rate carries `n` and a 95% Wilson interval. The card data is read from
PokeDojo and is not redistributed.
