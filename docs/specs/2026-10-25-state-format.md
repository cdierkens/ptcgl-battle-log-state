# Spec: A board-state format for battle-log reconstruction

Status: **Approved** (grilled 2026-10-26)
Package: `@dierkens.dev/ptcgl-battle-log-state` (new, sibling of the parser)
Depends on: `@dierkens.dev/ptcgl-battle-log-parser` — input only, no change
Related: [duplicate card identity](2026-10-25-duplicate-card-identity.md)
Vocabulary: [GLOSSARY.md](../../GLOSSARY.md)

This is the interop contract. Everything else in the reconstruction — the
lowering, the solver, the UI — can change after 1.0. This cannot, cheaply.

## Goal

Define a versioned JSON document for a reconstructed board, such that no
consumer can mistake a **set of possibilities** for a **fact**. It carries three
things: the state at a point in a battle log, the alternatives when the state is
not single-valued, and which of those two it is.

The governing rule from the identity spec applies here in the format: a
divergent prefix is a result, and the format has to make it say so.

## Non-goals

- A game engine, a rules authority, or a re-implementation of PTCG Live.
- An input format. Input is always a battle log.
- Lossless round-trip. State → log is not a goal and never will be.
- An XState, SCXML, or PDDL document. Those are adapters, outside this schema.
- Winning-play analysis. The format carries what happened, not what was best.

## Three artefacts

| Artefact | Analogue | Role |
|---|---|---|
| **Record** | PGN | the canonical lowered event stream, one per log |
| **Snapshot** | FEN | the reconstructed state at one prefix |
| **Determination** | — | `whole` / `divergent` / `unexecutable`, plus evidence |

**The record is primary.** A snapshot is derived from a record plus a solver
version, so it is re-derivable after the solver improves. A consumer that stores
only snapshots has frozen a bug. The format ships both; the README should say
which to keep.

## Design rules

| # | Rule | Why |
|---|---|---|
| R1 | Determinacy is a required field, never inferred from `candidates.length === 1`. | A consumer that forgets to check the count must not accidentally read a set as a fact. |
| R2 | Unknown is a value, not an absence. `null` means "not applicable". | Absence-as-unknown is the classic source of a silently wrong board. |
| R3 | The document never contains prose, locale, or a template key. Provenance is a line number. | The state is locale-free by construction; leaking a template key leaks the surface language. |
| R4 | `unexecutable` is a value with the offending line, never a throw. | A log that does not reconstruct is still worth storing and syncing. |
| R5 | Divergence is stored **per group**, not as a product of worlds. | The product is exponential and redundant: two groups with two alternatives is four worlds that differ in two places. |
| R6 | Ordering is stable: bench in play order, groups by first appearance, candidates by a documented canonical key. | Snapshots get diffed. Unstable ordering reads as churn. |
| R7 | Additive changes only within a major; the schema string carries the major. | Consumers pin this. |
| R8 | Every slot belongs to exactly one side's board, and no slot may be unreferenced. | A slot on both sides, or on neither, is a board-model lie the validator must catch rather than pass through. |

## Shape

```jsonc
{
  "schema": "ptcgl-state/1",
  "determinacy": "divergent",
  "prefix": { "phase": 12, "turn": 5, "line": 122 },
  "provenance": {
    "logHash": "sha256:…",
    "playerName": "cdierkens",
    "solver": "0.1.0"
  },
  "board": {
    "self":     { "active": "s0", "bench": ["s1", "s2"],
                  "hand": { "count": 4, "known": [] },
                  "prizes": { "remaining": 4, "known": [] } },
    "opponent": { "active": "o0", "bench": ["o1"],
                  "hand": { "count": 2, "known": ["Night Stretcher"] },
                  "prizes": { "remaining": 3, "known": [] } }
  },
  "slots": [
    { "id": "s0", "name": "Mega Kangaskhan ex", "group": null,
      "damage": 0, "attachments": ["Brave Bangle"], "zone": "active" },
    { "id": "s1", "name": "Kangaskhan", "group": "g0", "zone": "bench" },
    { "id": "s2", "name": "Kangaskhan", "group": "g0", "zone": "bench" }
  ],
  "groups": [
    {
      "id": "g0",
      "side": "self",
      "name": "Kangaskhan",
      "members": ["s1", "s2"],
      "since": { "phase": 4, "turn": 2, "line": 88 },
      "resolvedAt": null,
      "candidates": [
        { "s1": { "damage": 30, "attachments": ["Basic Psychic Energy"] },
          "s2": { "damage": 0,  "attachments": [] } },
        { "s1": { "damage": 0,  "attachments": [] },
          "s2": { "damage": 30, "attachments": ["Basic Psychic Energy"] } }
      ]
    }
  ],
  "properties": {
    "hp": { "self/Kangaskhan": { "min": 130, "max": 130, "source": "observed" } },
    "targeting": { "Trevenant/Cursed Roots": { "bench": true, "source": "observed" } }
  },
  "diagnostics": []
}
```

### Why groups, not worlds

A world is the product of every group's candidates. With `g` groups of `k`
alternatives that is `k^g` documents that differ in `g` places. Storing the
group's alternatives once gives `k·g`, and the consumer materialises a world only
if it wants one.

Two invariants make the compact form checkable:

- every candidate assigns **all** of the group's members, and no one else's;
- all candidates carry the **same multiset** of values — a group reorders
  evidence, it never invents or loses any. A candidate that breaks the multiset
  is a solver bug, and a validator catches it.

A slot in a group carries only facts common to every candidate (`name`, `zone`,
`id`). Anything that varies lives in the candidates. A slot outside a group is
its own truth and carries its values directly.

### Determinacy

| Value | Meaning | Shape |
|---|---|---|
| `whole` | one state per prefix | every group has exactly one candidate (or there are none) |
| `divergent` | ≥2 states survive | at least one group has ≥2 candidates |
| `unexecutable` | no state survives | `diagnostics` carries the line that broke it |

`divergent` is not a failure. `unexecutable` is: it means the lowering or the
learnt properties are wrong, or the log came from a different client version.

### Learned properties

HP and attack targetability are not part of the board; they are what the solver
has learnt *about* the board, as monotone bounds (see the identity spec). They
are separated for that reason: a consumer drawing an HP bar needs them, and a
consumer doing arithmetic on damage must not confuse them with state.

`source` is `observed` (proven by a knockout or a bench hit), `assumed` (a prior,
from an optional card database), or `unknown`.

### Provenance

`line` is the content line number in the source log. **The AST does not carry
line numbers**, so the lowering has to number lines itself — simplest by taking
the raw text alongside the parsed tree and walking both. A snapshot without a
line number cannot be pointed at evidence, which makes every bug report harder
than it needs to be.

### The record

```jsonc
{
  "schema": "ptcgl-events/1",
  "locale": "en",
  "playerName": "cdierkens",
  "logHash": "sha256:…",
  "events": [
    { "kind": "damage", "at": { "phase": 12, "turn": 5, "line": 168 },
      "source": { "side": "self", "name": "Dipplin" },
      "target": { "side": "opponent", "name": "Mega Excadrill ex" },
      "amount": 180,
      "breakdown": [
        { "label": "Brave Bangle", "amount": 30 },
        { "label": "Gladion's Final Battle", "amount": 80 },
        { "label": "Benched Pokémon", "count": 5, "amount": 100 },
        { "label": "Grass Resistance", "amount": -30 }
      ] }
  ]
}
```

Event kinds and their fields belong to the identity spec's lowering contract;
this document only fixes the envelope. The breakdown is carried as printed and is
not asserted to sum to `amount`: two arithmetic rules were falsified by real logs
(D22 of the identity spec), so it is provenance rather than a check.

## Decisions

| # | Decision | Why |
|---|---|---|
| F1 | One package carries both schemas (`ptcgl-events/1`, `ptcgl-state/1`). | Two consumers negotiating two versions of a language definition is a problem that does not exist yet. |
| F2 | Primary API is `reconstruct(rawText, opts)`, parsing internally; `lower(battleLog, rawText, opts)` is the secondary export. | Provenance needs line numbers the AST does not carry, and re-parsing is microseconds. |
| F3 | Snapshots come from a generator plus `snapshotAt(line)`, over one pure forward pass. | The audit needs every prefix; a UI needs one; materialising everything makes the common case expensive. |
| F4 | JSON Schema (draft-2020-12) is the document contract; Standard Schema V1 and Standard JSON Schema V1 are implemented as conformance. | Standard Schema standardises validators, not documents; JSON Schema serves non-TypeScript adapters. `@standard-schema/spec` is types-only, so zero-dep survives. |
| F5 | `validateDocument()` checks semantic invariants — group multiset equality, determinacy consistency — beyond what JSON Schema can express. | The dangerous documents are schema-valid and semantically wrong. |
| F6 | The record is canonical and carries `recordHash` alongside `logHash`. | Identifies log *and* solver version together, which is what a bug report asks. |
| F7 | Hidden zones are `{ count, known }`, never groups. | Unknown is not the same state as contested. |
| F8 | The core's only runtime dependency is the parser; XState, SCXML, and PDDL are separate optional adapters. | The parser is the input language, not an adapter; keeping the adapters out keeps the semantics out of a library's major-version cycle. |
| F9 | Group provenance in v1 is `since` plus `resolvedAt`; a constraint trace is deferred behind a debug option. | Keeps documents small, where debugging can afford a flag. |
| F10 | Schemas ship in the package under `schemas/`, with ids semver-locked to the major. | A third party can validate without adopting the runtime. |

## Alternatives rejected

- **Product-of-worlds snapshots.** Exponential and redundant. Rejected on R5.
- **XState snapshots as the wire format.** XState v5 was a breaking rewrite, so
  the format would track a library's major. The library is a fine *adapter*
  (one machine per world, `can(event)` as the definedness predicate); it is a
  bad standard.
- **SCXML.** The actual W3C statechart standard, and deterministic by
  construction — the opposite of the semantics this format has to carry.
- **PDDL.** The right standard for *domains and preconditions*, and a plausible
  exporter for anyone running an external planner. Not a state document.
- **A flat `worlds: World[]` with full boards.** Simple to consume, but it makes
  the exponential cost part of the contract and invites consumers to diff
  redundant data.
- **Omitting `determinacy`** and letting consumers check `candidates.length`.
  Rejected on R1: the failure mode is silent.

## Post-approval findings (2026-10-26, slice 2)

**A split is not representable.** F5's same-multiset invariant covers
permutations within one group. It does not cover a body leaving a group — an
evolution, a retreat among same-name copies, or a knockout — where the surviving
groups' multisets are correlated. The worked froslass example is the proof: after
`Slowpoke → Slowking`, the question is whether the Slowking or the surviving
Slowpoke carries 30 damage, and no `ptcgl-state/1` document with `slots` +
`groups` can say both. [The census](../audits/2026-10-26-fork-census.md) measures
it; `reconstruct()` stays out of scope until the format grows a cross-group
scenario.

**A move to a hidden zone has no source zone.** `moveCard` says the destination,
not whether the card came from the board or the discard. A card-recovery Trainer
can print `moved <card> to hand` while the same name is also in play. The ledger
keeps the body rather than deleting it on no evidence, and reports the
over-count; the event should carry a source zone (or the lowering should
distinguish the two templates) in a follow-up.

## Open questions

Settled at grilling (2026-10-26): snapshot caching (F3), group provenance (F9),
hidden zones (F7), record canonicalisation (F6), schema location (F10), and the
package's dependency posture (F8).

Two remain, and neither blocks slice 1:

1. Does the package ship a world materialiser (`toWorlds()`), or is expanding a
   group's candidates into complete worlds the consumer's job?
2. Do snapshots embed the record, or reference it by `recordHash` only? Embedding
   makes a snapshot self-contained and large; referencing keeps it cheap and
   dependent.
