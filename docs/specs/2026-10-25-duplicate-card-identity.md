# Spec: Duplicate card identity in a board reconstruction

Status: **Approved** (grilled 2026-10-26)
Repo: `ptcgl-battle-log-tracker`
Package: `@dierkens.dev/ptcgl-battle-log-state` (new, sibling of the parser)
Depends on: `@dierkens.dev/ptcgl-battle-log-parser` — no parser change required
Related (in `ptcgl-battle-log-tracker`): capture app extraction, deck identity, and the board-view spec this one defers to.
Vocabulary: [GLOSSARY.md](../../GLOSSARY.md)

A **board reconstruction** turns a [battle log](../../GLOSSARY.md) into a
turn-by-turn picture of both sides' boards. Consumers call this a "replay"; this
doc avoids that word because the glossary reserves *battle log* against it.

## Goal

Record what a battle log can and cannot say about **which physical card** an
effect hit, and fix the model and the UI vocabulary for the cases it cannot say.
The audience is anyone reconstructing board state from the parser's AST — this
repo, PokeDojo, Training Court, or a third-party viewer.

Two questions drive it:

1. What happens when a duplicate-name ambiguity is **never** resolved?
2. How is a surviving ambiguity **shown**, in a UI that imitates the game?

## The discovery

### What a damage line carries

Every applied-damage line carries exactly three things: the attacking side, the
attacking card name, and the target's side and card name.

```text
[attacker]'s [attackingPokemon] used [attack] on [defender]’s [targetPokemon] for [n] damage.
```

`blog_loc_applied_damage`, `src/templates/blog-templates.en.json:42`. Counter
placement (`blog_loc_put_damage_counter`, `:1192`), condition damage (`:106`),
healing (`:932`), and knockouts (`:951`) have the same shape.

### What it does not carry

- **No instance identity.** No serial, no card id, no slot index. There is no
  such placeholder in any of the 228 shipped keys, in any of the 7 locales.
- **Not even a zone.** The damage line does not say Active or Bench. Only
  attach, evolve, devolve, and retreat lines carry `in the Active Spot` / `on
  the Bench` (`:50`, `:881`, `:1240`). So a name present on both sides of the
  board is ambiguous in two dimensions at once.
- **No HP.** HP is never printed. A knockout is evidence about HP; it is not a
  measurement of it.

### Why this is the export's loss, not the parser's

The game engine picked a specific card and then wrote prose that names it. The
identity is dropped at export time, before any parser sees it. No parser can
recover it, and no template change would help — the line does not contain the
information. This is a property of the medium, and the model below is the only
honest response to it.

## Lowering: from the AST to events

The AST is a faithful tree of `(templateKey, groups)` — it is not an event
stream. Anything that reasons about play needs a **lowering** pass between them:
a total map from template key to a closed set of typed events. The parser already
lexes and parses; this is the semantic pass above it.

Its contract:

- **Total over the key set.** Every shipped key maps to an event kind or an
  explicit `unhandled`. A completeness test over `blogTemplateBundles` fails the
  build when the client adds a key. The key set is explicitly outside the
  parser's stability promise, so an unknown key must be loud — never dropped,
  because a dropped key is a quietly missing constraint.
- **Explicit field mapping, not placeholder-name guessing.** The same role
  arrives under different names: `blog_loc_applied_damage` uses
  `attackingPokemonCardName` / `targetPokemonCardName`,
  `blog_loc_discarded_attachment` uses `cardName` / `pokemonCardName`,
  `blog_loc_attach_card_bench` uses `sourceCardName` / `targetCardName`. The
  table is the pass.
- **Numbers parsed once.** `numDamage`, `numCounted`, `numDamageCounters`, and
  `numCards` are strings; damage counters convert to damage at ×10.
- **Sub-strings split by a locale-aware list rule.** `subString` is verbatim
  free text (ADR-0004 of the parser), and it is where card lists and discard
  piles live. `split(", ")` is not a rule — the separator is localized and card
  names can contain commas.
- **No identity.** `CardRef = { side, name }` plus an optional zone. The IR is
  exactly as ambiguous as the log, deliberately. Lowering is where guessing is
  most tempting and least recoverable.

The boundary test: the lowered events for one match must be identical in all
seven locales. Locale, prose, and placeholder names stop at this layer.

### Three traps the fixtures already contain

**Restatement.** `dipplin-vs-mega-excadrill.log` carries the same attack twice,
once as a main entry and once as a sub-entry just before the knockout:

```text
168  cdierkens's Dipplin used Do the Wave on Flyfrod’s Mega Excadrill ex for 180 damage. …
182  - cdierkens's Dipplin used Do the Wave on Flyfrod’s Mega Excadrill ex for 180 damage. …
183  - cdierkens chose Do the Wave
184  Flyfrod's Mega Excadrill ex was Knocked Out!
```

Emit both as damage and every world is invalid — the target takes 360. The IR
needs restatement semantics: a sub-entry that repeats its parent is the
confirmation of it, not a second hit.

**Breakdown arithmetic.** The same attack carries its components, which must sum
to the printed total:

```text
169  - Damage breakdown:
170     • (Pokémon Tool) Brave Bangle: 30 damage
171     • (Supporter) Gladion's Final Battle: 80 damage
172     • 5 Benched Pokémon: 100 damage
173     • Resistance to Grass: -30 damage
```

`30 + 80 + 100 − 30 = 180`. Tempting to use as a self-check, and wrong to. The
fixtures and then 28 corpus hits showed the breakdown is not a sum:

```text
Mirage Barrage   (total  90): Resistance to Fighting −30
Bare  150 explained          (total 300): Weakness to Fighting 150, Total 300
Gale Thrust      (total 230): Base 60, Damage 170, Damage 170, Total 230
Greedy Fang      (total   0): Base 70, Total 0
```

One is partial, one repeats a component, one has a `Total` that is zero while its
base is not. Equality and upper-bound rules each failed on a different row. So the
breakdown is carried as printed and asserted against nothing — it is provenance
for a human reading a log, not an invariant a machine can hold.

Prize counts (`cdierkens took 3 Prize cards`) are a different matter: that is a
number the game states once, and it stays a check on a knockout's value.

### A third trap: the apostrophe downgrade

The damage templates use a curly apostrophe before the defending player
(`[defendingPlayerName]’s`), while turn headers use a straight one. A damage line
with the straight form still parses — as `used_attack`, with the whole rest of the
line swallowed into `attackName`. The damage is then simply gone, with no error
anywhere:

```text
Alice's Slowking used Seek Inspiration on Bob's Celebi for 110 damage.
  -> blog_loc_used_attack, attackName: "Seek Inspiration on Bob's Celebi for 110 damage"
```

That is the parser being faithful to the template set, not a parser bug, and the
lowering reproduces it faithfully: an attack with no damage. The audit should
count `attack` events whose name contains a digit, because each one is a hit that
was lost on the way in.

## Semantics: the log is a program

Treat the lowered event sequence as a **program** in a small language whose
meaning is game state. Each template key is a production with a state transition
as its semantics, so a reconstruction is not a parse artefact — it is an
*interpretation* of the log.

That interpretation is **partial and nondeterministic**, and both properties are
the engine:

- **Partial.** An event is undefined on a state that cannot execute it: damage to
  a name that is not in play, a knockout where no candidate is at its HP, an
  evolution of a Pokémon that is not on the board, five cards discarded from a
  body holding four, a sixth Pokémon played to a five-Pokémon Bench. The real
  game executed the program, so the true state is never one where the program is
  undefined. **Partiality is the pruning mechanism.**
- **Nondeterministic.** Some productions have a choice domain — which of n
  indistinguishable instances, which energy onto which body. Evaluating one
  yields a *set* of successor states.

So the state at step `k` is a set, and the reconstruction is a set of state
sequences. Three outcomes:

| Outcome | Meaning |
|---|---|
| **Whole** | exactly one state per prefix — the reconstruction is single-valued |
| **Divergent** | two or more states survive every remaining prefix |
| **Unexecutable** | no state survives — a defect, not an ambiguity |

World count and picture count are different claims: two Kangaskhan each holding
one Psychic Energy is *divergent* and *confirmed* at the same time. The audit
reports the second, because it is what a viewer sees.

Invalidation and divergence are different things and easy to conflate:
invalidation is the mechanism and it runs on every step; divergence is the
residue that survives it. A divergent interval can heal when a later prefix is
undefined on all but one state — which is exactly the interval the timeline
draws.

Determinacy is a property of the *set*, not of the inputs. A board can be whole
while carrying an unknown HP, as long as every surviving state renders the same.

**Validity is a suffix property.** A state can be locally executable and still
die later, so "validated" can only mean *viable to the end of the program*.
Forward propagation plus a viability check on the remaining suffix is the honest
formulation; a single forward pass gives executability, not validity.

### The couplings that make it a state machine

Most identity reasoning separates per group, which is what keeps it cheap. Two
constraints do not, and they are worth having because they are strong:

- **Bench capacity (5).** A knockout frees a slot; a play needs one. This couples
  plays to knockouts across every group.
- **The prize pool (6).** `took N Prize cards` must reconcile with the knockouts
  and their values, which depends on which body died. Prize arithmetic is a
  global check that is nearly free.

These are the reason the reconstruction is a machine rather than a per-name
ledger, and the reason a wrong local choice surfaces as an unexecutable suffix
instead of a silently wrong board.

## Model

### Rules depth

The semantics models the **board**, not the game:

- **Modelled**: active/bench composition, damage, attachments (Energy and Tools),
  evolution, devolution, knockout, prize movement, bench capacity.
- **Not modelled as state**: status conditions — each condition-damage line is an
  independent damage event — abilities as such, Stadium effects, hand and deck
  contents, discard ordering.
- **Hidden zones** are a count plus the multiset of cards whose identity the log
  gave: `hand: { count, known }`, `prizes: { remaining, known }`. Never an
  identity group. A face-down prize has no candidate set because there is no
  evidence, which is not the same state as contested evidence.

Everything outside the board is a fold-in/fold-out event with no internal
structure. This is a deliberate ceiling: a rules engine is a different project,
and the reconstruction only needs enough to decide *which body* an effect touched.

### Groups, not slots

Damage is stored on an **identity group**: the set of Pokémon on one side that
share a card name and a zone, and that nothing so far distinguishes. A group
carries a multiset of damage values, not one value per slot.

A slot only becomes a distinct **instance** when an event distinguishes it. Until
then, inventing an assignment is inventing data.

### Resolution events

Resolution is elimination, not guessing. These events force a split:

| Event | What it forces | Needs card data |
|---|---|---|
| `X was Knocked Out!` | one copy of X reached its HP | HP (known or learnt, below) |
| `evolved X to Y` / `devolved` | the source name leaves the group | no |
| `retreated X to the Bench`, `X is now in the Active Spot`, `moved X to the Active Spot` | the mover changes zone | no |
| `moved X to their deck / discard / hand / Lost Zone / Prize cards` | the card leaves the board | no |
| `healed`, `moved damage counters from X to Y` | arithmetic on X's counters | no |
| damage modification sub-lines (`took -30 less`, `took 170 more`) | arithmetic on one hit | no |

Card data supplies a second pruning channel the log cannot: **targetability**.
Most attacks can only hit the Active Spot, so an Active-only attack prunes the
same-name Bench candidates for free.

### Card properties are learnt, not shipped

The parser ships no card database, and the log never prints an HP value — but it
is a continuous supply of *constraints on* those values, which is stronger than a
missing constant:

- a knockout at cumulative damage `d` proves `HP <= d`;
- a survival at cumulative damage `d` proves `HP > d`;
- a hit that exactly knocks out, beside an earlier hit that did not, brackets HP
  to `(d', d]`.

Per `(card name, printing)` the solver carries HP as an **interval**, tightened
monotonically as the log proceeds. One match gives brackets; a folder of logs
converges on the number. The same holds for **targetability**: an attack observed
damaging a benched Pokémon can hit the Bench; an attack never observed doing so
is only a prior, never a hard prune.

Because the log names cards and not printings, the domain is a *set* of intervals,
one per printing. When two printings differ in HP, a knockout identifies the
printing — a bonus output, and a reason not to collapse the name.

The rule that keeps this sound: a bound only ever tightens by proof. If the
solver needs an HP to make progress, it has already left the log.

### The attachment ledger

Energy and Tools are the sharpest evidence in the log, because they are typed,
counted, and named at both ends:

```text
[player] attached [sourceCard] to [targetCard] on the Bench.   -- blog_loc_attach_card_bench
[card] was discarded from [player]'s [pokemon].                -- blog_loc_discarded_attachment
[n] cards were discarded from [player]'s [pokemon].            -- blog_loc_discarded_attachment_multi
```

Attachments survive evolution, and a knockout enumerates the dying body's whole
pile in the multi-card line's sub-entries. That gives a conservation law:

> everything attached to a side, minus everything discarded from named bodies,
> is the sum over the surviving bodies — and a knockout names one part exactly.

With two candidates the complement is forced, which resolves *which body* and
*which energy* at once. With three it narrows without resolving. This is the
Crispin case: one attach line naming a card name shared by two Kangaskhan, then a
knockout some turns later that discards its pile from one of them — the same
mechanism as a bench snipe, with typed tokens instead of damage.

Note the observability trap: if both Kangaskhan end up with one Psychic Energy,
the two worlds render identically. World count and visible ambiguity are
different quantities, and only the second belongs to the UI.

### The world graph

Enumerate candidate worlds, but only where the log forks:

- the graph is a **path with occasional forks**, not a tree. Most lines have
  exactly one successor; only ambiguous events branch.
- every transition **re-checks** the open groups, so most branches die within a
  few lines of the fork that created them.
- worlds that differ only in the labelling of indistinguishable instances are
  **merged**. Skip this and each fork costs a factorial, not a factor of two.
- the **frontier** is the unit to measure. Cost tracks its size, not the number
  of forks, and a fork that resolves immediately never grows it.

Identity, HP, targetability, and attachment partitions form one constraint
system, not alternating passes. Bounds tighten; they are never guessed.

### Never resolved

**An unresolved ambiguity is a result, not a failure.** It is the correct
statement that two worlds are consistent with every line of the log.

The two worlds are not equally interesting. Classify them:

- **Cosmetic.** Both worlds produce the same board, the same knockouts, the same
  prizes, the same everything a consumer would derive. The physical card
  differs; nothing observable does. A reconstruction may pick one.
- **Material.** The worlds differ in something a consumer or a viewer depends
  on: which copy carries damage, whether one is one hit from a knockout, which
  copy a later evolution consumed.

Materiality is about *downstream dependence*, and it is usually decidable by
propagating both worlds forward. A reconstruction should compute it rather than
assume it. Note the asymmetry: an ambiguity that is never resolved **cannot** be
material to derived facts — nothing later depended on it — but it can still be
material to the picture the viewer is looking at.

**Persistence.** Store the group and its surviving hypotheses; never store a
chosen hypothesis as if it were fact. Any persisted board that had to pick must
record `assumed: true` beside the pick, so a later re-render can discard it.
Persisting a resolved-looking board silently is the one unrecoverable mistake:
the evidence is in the log, but the assumption is not.

**Determinism.** Any display hypothesis must be a pure function of the log,
the card data, and a documented ordering (play order). Two runs over the same
log must agree. Never depend on `Map`/`Set` iteration order or randomness — a
board that changes between renders reads as a bug.

**Contradiction.** If no hypothesis satisfies the constraints — a knockout where
no candidate had the HP, or two printings of one name with different HP — that
is a defect in card data or the parser, not an ambiguity. Surface it as a
diagnostic. Never clamp damage to make it fit.

Knowledge of the whole log is available up front. Prefer one deferred pass with
group constraints over a greedy pass that commits early: the greedy pass is what
turns a resolvable case into a wrong one.

#### Worked example: resolved late, not early

`ptcgl-battle-log-parser/src/__tests__/fixtures/slowking-vs-froslass-mill.log`:

```text
113  TSLAUJ's Trevenant used Cursed Roots on cdierkens’s Slowpoke for 30 damage.
122  cdierkens evolved Slowpoke to Slowking on the Bench.
141  TSLAUJ's Trevenant used Cursed Roots on cdierkens’s Slowpoke for 30 damage.
142  cdierkens's Slowpoke was Knocked Out!
```

At 122 nothing distinguishes the two Slowpokes, and a greedy resolver must
guess. The guess is falsifiable at 142: a 30-damage hit only knocks out a
60-HP Slowpoke that already carried 30, so the copy that took the 113 damage is
the copy that stayed a Slowpoke — the evolved one was clean. This holds because
evolution preserves damage counters, which is card behaviour, not log evidence.

Nineteen lines separate the question from the answer. That is the case for
deferral.

#### The same example, unresolved

If the log had stopped at 122, the two worlds would be observationally
identical — Slowking at 0 damage, Slowpoke at 30 — and the ambiguity would be
cosmetic. That is the common shape of the never-resolved case: a bench snipe on
a copy the opponent never evolves or knocks out. It ends the match unresolved,
and it never mattered.

## Measurement

The design claim — most logs collapse to one board, a small fraction never do —
is a hypothesis until a corpus says otherwise. It is measured, not asserted.

### Corpus

PokeDojo's Firestore `workspaces/{uid}/games/{gameId}.rawLog`. The full text is
retained by design: *"so we can re-parse deterministically if the parser
improves"* (`packages/types/src/game.ts`). Battle logs never reach BigQuery —
`pokedojo_ingest.raw_items` is external ingest — so extraction is a read-only
admin script in `pokedojo.pro/scripts/`, the sanctioned place for read-side CLI.
No raw text leaves PokeDojo: aggregates out, and any sample redacted the way the
parser's fixture tool redacts handles.

`Game` carries no locale, so the script detects it per log and reports per
locale. That is the only way to test the localized list splitter, and the one
thing the committed fixtures cannot tell us.

### Three figures, not one

| Figure | Definition |
|---|---|
| **Never confirmed** — headline | ≥1 group still has ≥2 render-distinct candidates at the final prefix |
| **Ever divergent** | a fork occurred at some point, whether or not it collapsed |
| **Confirmed late** | forked but collapsed before the end |

A single scalar would conflate *briefly unsure* with *never found out*, and only
the second is the product problem.

**Confirmed means render-distinct.** Two Kangaskhan each holding one Psychic
Energy are two worlds and one picture, so they are confirmed. World count is
reported separately, as a solver debug metric.

### Two passes

1. **Fork census.** Logs where a choice point occurred at all. Needs only the
   lowering plus a greedy ledger, and it is an *upper bound* on divergence: if 3%
   of logs fork, never-confirmed is at most 3%.
2. **Residue.** The full solver, which turns forks into surviving sets. The true
   number lands between the census and zero, and that gap is what the solver is
   worth.

### Two runs, with and without card data

Bare (HP and targetability learnt from the logs) and informed (HP and
targetability from PokeDojo's `cards` read model). The delta is the price of
shipping no card database — the number that decides whether the zero-dependency
posture is affordable.

### Unexecutable is a gate, not a figure

A log where no world survives is a defect in the lowering, the rules, or the
client version — never "cannot be confirmed". It is reported separately and must
sit at zero; otherwise the audit is reported as untrustworthy rather than quoted.

### Reporting

Every rate carries `n` and a 95% Wilson interval, stratified by locale and by
template key where `n` allows. At p ≈ 1%, n = 1,000 gives roughly ±0.6 points and
n = 10,000 gives ±0.2 — so corpus size decides what claim is available. Results
land in `docs/audits/` as dated notes recording method, `n`, the numbers, and the
solver commit that produced them; this spec cites the latest.

## UI

The picture imitates a game, so it is read as a statement of fact. Two rules
follow, and both are about not lying.

### Never show more certainty than the log supports

The reconstruction displays four states, with one vocabulary:

| State | Meaning | Example |
|---|---|---|
| **Known** | one card, one value | an Active Spot Pokémon |
| **Ambiguous** | ≥2 cards, evidence cannot split them | two Slowpokes, one sniped |
| **Hidden** | the card exists but its identity is not in the log | face-down Prize cards, deck order |
| **Inferred** | derived from card data or an arithmetic rule, not stated | HP after a damage line |

Ambiguous and hidden are the same problem — the board knows a card is there and
not which one — so they share a marker. Hiding the difference between *hidden*
and *known* is what makes a reconstruction look authoritative when it is not.

### Rendering an ambiguous group

- **Mark the group, not a slot.** The marker belongs to the set. Bind the member
  slots visually — a shared dashed boundary, or a brace — and label them
  `1 of 2` in text.
- **Never rest the meaning on colour.** ADR 0003 leaves no warning tone in the
  token contract, and its rule is that meaning never rests on colour alone.
  Ambiguity is a dashed `border-muted-foreground` boundary plus a text badge,
  sized and placed like the other slot chrome. A theme change must not erase it.
- **Do not dim the board.** Ambiguity is local. Dimming everything says the
  reconstruction failed; it did not.
- **Show damage as the group's multiset, not per slot.** "30 each" / "30
  total" is honest. Two slots each labelled 30 is not: it asserts a
  distribution the log never gave.
- **Do not animate damage into a slot.** An effect flying to slot 2 is a lie
  performed at 60 fps. It resolves against the group or the boundary.
- **Offer the alternatives, do not hide them.** A group opens to show its
  surviving hypotheses. A viewer who cares can see what is and is not known.

### Retrospective resolution

When a late line resolves an earlier ambiguity, prefer **re-rendering history**
with the resolved assignment, and marking the interval where it was unknown.
The game did have an answer; the picture is supposed to show the game. The
alternative — freezing the board as it was believed at the time — is
*chronologically honest but wrong about the board*, and it makes step N depend on
what the engine knew at step N, which no viewer asked for.

Either way, the marker must not vanish silently. A resolved group keeps a
"resolved at turn N" note, so a viewer who saw the dashed boundary is not left
wondering whether they imagined it.

### Timeline

Ambiguity is an interval, not a frame. The scrubber marks where a group became
ambiguous and where it was resolved; a group still ambiguous at the end of the
log gets a distinct terminal marker. That single affordance answers "what was
never recovered" without a report: it is the set of intervals that reach the end.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Damage is stored on an identity group keyed by `(side, card name, zone)`, not on slots. | The log carries no instance identity; a slot value would be invented. |
| D2 | Slots become distinct instances only when a resolution event forces a split. | Keeps the model as uncertain as the evidence. |
| D3 | Resolution is deferred; the reconstruction may use the whole log. A greedy per-line commit is not acceptable. | The worked example is unresolvable at 122 and forced at 142. |
| D4 | HP and attack targetability are solver variables learnt from the log as monotone bounds, not constants that must be shipped. | The log never prints them, but every knockout and every bench hit constrains them; a solver with no card database is weaker, not blind. |
| D4a | A bound tightens only by proof. Never assume a card property to make progress. | An assumed HP silently prunes the true world. |
| D5 | Survivors are classified cosmetic vs material by propagating hypotheses forward. | Lets the UI be quiet where it can be and explicit where it cannot. |
| D6 | Ambiguity persists as a group plus hypotheses. A rebuilt board never stores a hypothesis as fact; any pick is marked `assumed`. | Re-render must be able to discard an assumption. |
| D7 | A display hypothesis, if used, is a pure function of log + card data + play order. | Two renders of one log must agree. |
| D8 | No hypothesis fitting the constraints is a diagnostic, not an ambiguity. | A contradiction means bad card data or a parser defect. |
| D9 | Ambiguous and hidden share one marker and one vocabulary. | Both mean "a card is here, its identity is not". |
| D10 | The marker is a dashed boundary plus a text badge; no colour, no board-wide dimming. | ADR 0003 has no warning tone, and meaning never rests on colour. |
| D11 | Damage on a group is shown as a multiset, and effects never animate into a specific slot. | Both would assert an assignment the log never made. |
| D12 | Late resolutions re-render history and leave a "resolved at turn N" marker. | The picture should show the game, not the engine's mid-match belief. |
| D13 | The timeline marks ambiguity intervals, including ones that reach the end of the log. | Makes "never recovered" visible instead of needing a report. |
| D14 | Energy and Tool attachments are tracked as a conservation ledger; a knockout's discard pile names one body's part exactly. | Typed, counted tokens make this the strongest evidence in the log — stronger than damage arithmetic, and it survives evolution. |
| D15 | Worlds that differ only in the labelling of indistinguishable instances are merged before pruning. | Without merging, each fork costs a factorial; with it, a factor of two. |
| D16 | Ambiguity is resolved by re-checking open groups on every transition, not by branching eagerly at every line. | Local feasibility kills most branches immediately; a fork that resolves on its own never grows the frontier. |
| D17 | The frontier is the cost metric, instrumented per group. | Log length is linear; world count is not. The frontier is what actually has to stay small. |
| D18 | Visible ambiguity is measured on render-distinct worlds, not world count. | Two Kangaskhan each holding one Psychic Energy are two worlds and one picture. |
| D19 | A lowering pass maps every template key to a typed event; the solver never reads `templateKey`, `groups`, or prose. | Placeholder names differ per template and change with the client; the solver needs one vocabulary. |
| D20 | The lowering table is total — an unknown key becomes an explicit `unhandled` and fails a completeness test. | The key set is outside the parser's promise; a dropped key is a silently missing constraint. |
| D21 | A sub-entry attack that repeats a main-entry attack in the same phase is a restatement and is collapsed. Secondary damage has no attacker and is never collapsed. | The fixtures contain both: a repeated Do the Wave, and two identical `Weedle took 110 damage` lines that are two different cards. |
| D22 | A damage breakdown is carried as printed and never reconciled. | Two arithmetic rules failed against real data: equality flagged honest partials, and an upper bound flagged duplicated component lines and legitimate 0-damage hits. It is provenance, not a claim. |
| D23 | The lowered log is interpreted as a program: events are partial, nondeterministic state transitions, and undefinedness is what prunes. | The game executed the program, so no true state can be undefined on it. This replaces "guess and check" with a semantics. |
| D24 | Each prefix is reported as whole, divergent, or unexecutable; a divergent prefix is never collapsed. | Invalidation is the mechanism, divergence is the residue; only the second is a UI fact and only the third is a defect. |
| D25 | Validity is viability of the remaining suffix, not local executability. | A state that runs the next line and dies three lines later was never valid. |
| D26 | The package is `@dierkens.dev/ptcgl-battle-log-state`; the tracker takes no dependency on it in v1. | The name is public and permanent, and the board view is its own later spec. |
| D27 | The semantics models the board only; status conditions and non-board zones are opaque fold-in/fold-out events. | A rules engine is a different project; the reconstruction only needs to decide which body an effect touched. |
| D28 | Hidden zones are a count plus known cards, never identity groups. | Contested evidence and absent evidence are different states, and only the first is resolvable. |
| D29 | The audit corpus is PokeDojo's Firestore game logs, read by a read-only script that emits aggregates. | Private data and other people's logs; the player's log folder must not become a corpus by accident. |
| D30 | Never-confirmed is the headline figure, with ever-divergent and confirmed-late beside it. | One scalar conflates "briefly unsure" with "never found out". |
| D31 | Confirmed means one render-distinct world; world count is a debug metric. | The viewer sees a picture, not our representation. |
| D32 | Unexecutable sits at zero, or the audit is reported as untrustworthy. | A defect rate folded into a residue rate makes both uninterpretable. |
| D33 | The audit runs twice — bare, and informed by PokeDojo's card data — and reports the delta. | The delta is the cost of zero-dep, and it decides whether shipping no card database is affordable. |
| D34 | Rates carry `n` and a 95% Wilson interval; results live in dated `docs/audits/` notes with the solver commit. | Point estimates get quoted forever as though they were facts. |
| D35 | Card names are recorded verbatim, including count phrases such as `2 cards`. | The lowering does not interpret names. A phantom name the solver cannot match is honest; a guessed card name is not, and the phrase is localized. |

## Post-approval findings (2026-10-26, slice 2)

**The group key is `(side, card name)`, with zone on the body.** D1 says
`(side, card name, zone)`, but a damage line carries no zone: a name present in
both the Active Spot and the Bench cannot be assigned to one zone key without
inventing one. The ledger groups by `(side, card name)` and carries `zone` on
each member; the document's `IdentityGroup` already has no zone field. D1's
wording should be read that way until it is amended.

**A split is not representable in `ptcgl-state/1`.** F5's invariant says every
candidate of a group carries the same multiset. That covers permutations inside
one group, not the case where a body *leaves* a group — an evolution, a retreat
among same-name copies, or a knockout — and the surviving group's multiset
depends on which body left. The worked froslass example is exactly that shape:
after `Slowpoke → Slowking`, the Slowking and the surviving Slowpoke are separate
groups, and each slot outside a group must carry its own damage. The census
measures the ambiguity; `reconstruct()` cannot emit it until the format grows a
cross-group scenario (or candidates that span groups). Raised here, not worked
around.

## Open questions

The design answers are settled (grilled 2026-10-26). Two remain, and both belong
to the **board-view spec** this one defers to:

1. Does the default view show a display hypothesis, or always the group? D6
   permits either; the deciding input is how much "1 of 2" a viewer tolerates.
2. Retrospective re-render versus a committed view — D12 recommends re-render,
   but a step-through viewer may prefer stability. One mode, or both?

Resolved elsewhere: scope and packaging (D26), card data (the D33 delta decides
it), frontier size (the audit measures it), and the other never-resolved classes
(D28).

## Non-goals

- Changing the parser's AST, its templates, or its error surface. There is no
  information in the log to expose.
- Recovering identity from screenshots, OCR, or any other in-game automation
  (ADR 0001).
- Perfect per-slot fidelity. Some ambiguity is genuinely permanent, and the
  spec's answer is to show it, not to erase it.
- A new visual language for uncertainty outside the shadcn token contract.
