# PTCGL battle-log state

[![CI](https://github.com/cdierkens/ptcgl-battle-log-state/actions/workflows/ci.yml/badge.svg)](https://github.com/cdierkens/ptcgl-battle-log-state/actions/workflows/ci.yml)

Reconstruct the board from a [Pokémon TCG Live](https://pokemon-tcg-live.com)
battle-log export — and say so when the log cannot settle it.

A battle log names cards, never instances. When two Kangaskhan are in play, a
damage line says *which name*, not *which body*. This package reconstructs what
the log actually supports, in a form where a **set of possibilities cannot be
mistaken for a fact**.

> **Status: pre-release.** The lowering pass, the document validator, the board
> ledger, and the fork census ship. `reconstruct()` and the full solver are next.
> See [the design spec](./docs/specs/2026-10-25-duplicate-card-identity.md) and
> the [first census](./docs/audits/2026-10-26-fork-census.md).

## Install

```sh
pnpm add @dierkens.dev/ptcgl-battle-log-state
npm  install @dierkens.dev/ptcgl-battle-log-state
```

Requires Node **>= 22.12.0**. ESM only.

## The idea

The parser gives you a faithful tree of template events. That tree is a program
in a small language whose meaning is board state — and the interpretation is
**partial** and **nondeterministic**:

- **Partial.** An event that cannot happen in a state (a knockout where nothing
  is at its HP, five cards discarded from a body holding four) invalidates that
  state. The game ran the program, so the truth is never on an impossible state.
- **Nondeterministic.** Some events have a choice domain — which of two identical
  cards, which energy onto which body. Evaluating one yields a set.

So a prefix is one of three things, and the document always says which:

| Determinacy | Meaning |
|---|---|
| `whole` | one board |
| `divergent` | two or more boards survive; the alternatives travel with the document |
| `unexecutable` | no board survives — a defect, not an ambiguity |

## Usage

```ts
import { isErr, validateDocument } from "@dierkens.dev/ptcgl-battle-log-state";

const result = validateDocument(unknownDocument);
if (isErr(result)) {
  for (const issue of result.error.issues) {
    console.error(issue.path, issue.message);
  }
}
```

`validateDocument` checks more than the shape: that a group's candidates agree,
that a `divergent` document actually diverges, and that a slot inside a group
does not smuggle in a value the group was supposed to hold. Those invariants are
why it exists — a schema-valid document can still be a lie.

## The ledger and the census

`runLedger(events)` walks the lowered event stream and keeps one **identity
group** per `(side, card name)`. A group holds the distinct value multisets its
bodies can have — zone, damage, attachments — so permutations are never
enumerated. `census(events)` reduces that to three figures:

```ts
import { census, lower } from "@dierkens.dev/ptcgl-battle-log-state";

const lowered = lower(battleLog, rawText);
if (lowered.ok) {
  const result = census(lowered.value.events);
  result.neverConfirmed;  // a live group still renders more than one picture
  result.everDivergent;   // a fork happened at some point
  result.confirmedLate;   // a fork happened, but every group collapsed
}
```

The census is **not** the full solver: it is a forward pass with no
backtracking, and it drops cross-group correlation when a body leaves a group.
Both choices can only over-report divergence, which is the direction an
upper-bound measurement needs. Card HP is learnt per body from survivals and
knockouts; `census(events, { oracle })` is the seam for an informed run, where
`oracle` is a `CardOracle` supplied by the caller.

`pnpm run census:fixtures` runs the same aggregation over the committed logs.

## Divergence is stored per group

A list of complete boards grows exponentially: `g` groups with `k` alternatives
is `k^g` boards that differ in `g` places. The document stores each group's
alternatives once (`k·g`) and a consumer materialises a board only if it wants
one.

Two invariants keep that compact form honest, and the validator enforces both:
every candidate assigns **all** of a group's members and no one else's, and every
candidate carries the **same multiset** of values. A group reorders evidence; it
never invents or loses any.

## Licence

MIT. Pokémon and Pokémon TCG Live are trademarks of The Pokémon Company. This
project is not affiliated with or endorsed by them.
