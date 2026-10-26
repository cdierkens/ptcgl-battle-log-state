# PTCGL battle-log state

The vocabulary this package uses, and the words it refuses. Terms are for
reconstruction; the parser's own vocabulary lives in that package.

## Reconstruction

**Board reconstruction**:
Turning a battle log into a turn-by-turn picture of both sides' in-play Pokémon.
It is not a replay of the game and not a simulation of it.
_Avoid_: replay, simulation, state machine, game state

**Board**:
Both sides' Active Spot and Bench, with each Pokémon's damage and attachments, at
one prefix. The rest of the game — hand, deck, discard, Stadium, Prized cards —
appears only as counts.
_Avoid_: game state, snapshot (except as the wire artefact), frame

**Prefix**:
A point in a battle log that a board is reconstructed at: phase, turn, and content
line.
_Avoid_: step, timestamp, tick

**Identity group**:
Pokémon on one side that the battle log cannot tell apart, because it names cards
and never instances. Damage lands on the group until something splits it.
_Avoid_: candidate set, ambiguity cluster, duplicate pile

**Whole**:
A prefix with exactly one surviving board. A divergent prefix can still render as
one picture; the two are not the same claim (see **Confirmed**).
_Avoid_: confirmed, resolved, definite

**Divergent**:
A prefix with two or more boards that every remaining line of the log is
consistent with.
_Avoid_: ambiguous (as a noun), unknown, uncertain

**Confirmed**:
A prefix whose surviving boards all render identically, even if there is more than
one of them. This is the figure a corpus audit reports, because it is what a
viewer sees.
_Avoid_: whole, certain, settled

**Render-distinct**:
Two worlds that produce different pictures. A group that reorders identical
values is not render-distinct; a group whose members carry different damage is.
_Avoid_: visible, material (material is about downstream dependence, not the
picture)

**Fork**:
The moment an identity group first renders more than one picture. A fork is not a
verdict: later lines can collapse it, and most forks in the census do not collapse
before the log ends.
_Avoid_: branch, split (a split is a specific event that removes a body from a
group)

**Never confirmed**:
The census headline: a log whose final prefix still has at least one identity
group rendering more than one picture. A saturated group counts here because its
variant set was truncated and cannot be decided.
_Avoid_: unresolved, ambiguous

**Confirmed late**:
A log that forked and whose every group collapsed before the end.
_Avoid_: resolved late

**Unexecutable**:
A prefix where no board survives the log's own constraints. A defect in the
lowering, the rules, or the client version — never a form of ambiguity.
_Avoid_: invalid, broken, failed

**Lowering**:
Mapping the parser's template events into a locale-free, typed event language that
the reconstruction reads. The parser is lexer and parser; this is the pass above
it.
_Avoid_: lexer, desugaring, normaliser

**Record**:
The canonical lowered event stream for one battle log.
_Avoid_: event log, trace, transcript

**Learnt property**:
A card fact the log constrains without stating — an HP interval, whether an attack
can hit the Bench. Tightened only by proof, never assumed.
_Avoid_: card data, heuristic, guess
