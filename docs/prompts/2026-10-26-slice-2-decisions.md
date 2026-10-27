# Decisions — slice 2: ledger and census

Date: 2026-10-26
Prompt: [`2026-10-26-slice-2-ledger-and-census.md`](2026-10-26-slice-2-ledger-and-census.md)

The prompt left three questions open. These are the answers this slice builds
on, with the reason each one is cheap to reverse or expensive to get wrong.

## 1. Module split — two files

`src/ledger.ts` owns the board: groups, variants, zone moves, attachments,
knockouts, learnt HP. `src/census.ts` owns the figures: run the ledger, count
forks, never-confirmed, confirmed-late, and the debug cost metrics. The census
does not reach into a group's internals; it consumes the snapshot the ledger
publishes.

One module would have two reasons to change — the board's rules and the
measurement's definitions — which is exactly Divergent Change. The split also
keeps the solver's future in one place: when the full solver lands, it replaces
`ledger.ts` without touching how the audit counts.

## 2. HP modes — per-body bounds now, a card-data seam later

The ledger keeps an **HP interval per body**, not per name. A survival at
cumulative `d` raises that body's `min` to `d`; a knockout removes the body and
bounds its `max` by `d`. Values carry their interval, so a body that evolved
resets it (the new card has a different HP) while its damage and attachments
carry over.

Per-body rather than per-name matters. If two copies of one name are different
printings, one can have HP 30 and the other 60; a survival at 30 proves only the
copy that was hit has HP > 30. A per-name interval would silently prune the
mixed-printing world. It would also resolve the worked froslass example without
card data — and that resolution is not in the log.

The package ships a `CardOracle` port for the informed run, but slice 2 runs
bare: the oracle is unset and every bound is learnt from the log. The informed
run needs PokeDojo's `cards` read model and a targetability adapter, which belong
in `pokedojo.pro`, not here. The audit reports bare as an upper bound and says the
delta is unmeasured; the port makes the second run a data problem rather than a
ledger change.

## 3. A fork worth reporting — a change of rendered picture

A group's answer is the **multiset of its members' values** — zone, damage,
attachments — not a particular labelling. Two variants that are permutations of
one multiset are one picture; D31 says that is confirmed. So:

- **render-divergent** = the set of value multisets has more than one member;
- **internally divergent** = the raw variant count is more than one.

The headline uses render-divergent. Internal count is a solver cost metric,
reported separately. This also makes the census cheap: permutations never need
enumerating, so a group of six does not cost a factorial.

## Consequence: the document format cannot carry a split

F5 requires every candidate of a group to carry the same multiset of values.
That covers permutations inside one group. It cannot express the case where a
body *leaves* a group — an evolution, a retreat among same-name copies, or a
knockout — and the remaining group's multiset depends on which body left.

The worked froslass example is that shape: after `Slowpoke → Slowking`, the
question is whether the Slowking or the surviving Slowpoke carries 30 damage.
They are separate groups, and each slot outside a group must carry its own
damage, so no `ptcgl-state/1` document can represent both worlds. The census can
measure it; `reconstruct()` cannot emit it until the format grows a cross-group
construct (a `scenarios` array, or candidates that span groups). That is a
finding for the format spec, raised here rather than worked around.

The census therefore drops cross-group correlation when a split happens. That
can only *over*-report divergence, which is the promised direction for an upper
bound: never-confirmed in this audit is at least the true value, never below it.
