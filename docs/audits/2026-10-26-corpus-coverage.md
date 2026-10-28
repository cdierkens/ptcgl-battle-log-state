# Audit: lowering coverage over the PokeDojo corpus

Date: 2026-10-26
Scope: slice 1b — does the lowering cover what real battle logs contain?
Solver: pre-commit scaffold (`@dierkens.dev/ptcgl-battle-log-state` 0.1.0, lowering 66/162 table)
Corpus: 411 games across 5 workspaces, Firestore `workspaces/*/games/*.rawLog`

## Method

Read-only. `pokedojo.pro/scripts/audit-battle-log-coverage.mjs` walks every
workspace's `games` subcollection, runs `detectBattleLogLanguage` →
`parseBattleLog` → `lower`, and prints counts. It writes nothing, and no battle
log leaves Firestore: the report contains counts, line numbers and keys, never
text. The same aggregation runs over the committed fixtures via
`pnpm run audit:fixtures`, so the report format is reproducible without the
corpus.

17 seconds for 411 games in one process, sequentially. Nothing about this needs
a batch system.

## Results

| | |
|---|---|
| logs scanned | 411 |
| parsed | 411 (0 failures) |
| lowered | 410 (1 failure) |
| locales | `en` 411 |
| unhandled keys | **0** |

**Every content line in 411 real logs matched a shipped template,** and every
matched key was covered by the table — 66 mapped, 162 explicitly ignored. The
`unhandled` bucket, which fails the build when it is non-empty, never fired.

Events produced across the corpus:

| kind | count | | kind | count |
|---|---|---|---|---|
| play | 13,892 | | knockout | 1,811 |
| draw | 12,855 | | prizeTaken | 1,689 |
| moveCard | 6,736 | | detach | 1,620 |
| counterDamage | 5,867 | | endTurn | 1,173 |
| attack | 5,348 | | moveCounters | 1,009 |
| attach | 4,689 | | retreat | 851 |
| evolve | 2,685 | | switchActive | 800 |
| prizeRevealed | 2,430 | | heal | 40 |
| damage | 2,427 | | devolve | 6 |

`heal` and `devolve` fired here and never in the four fixtures: the corpus
exercises mapped code the regression suite does not.

Ignored lines: flavour 8,472 · breakdown 1,094 · header 824 · unmodelled 409 ·
fragment 205 · restatement 43 (since removed; see amended D21).

## Findings

### F1 — 3.4% of attacks silently lose their damage

183 of 5,348 `used_attack` events carry a damage clause inside `attackName`
(≈3.4%, 95% Wilson 2.9–3.9):

```text
Alice's Slowking used Seek Inspiration on Bob's Celebi for 110 damage.
  -> blog_loc_used_attack, attackName: "Seek Inspiration on Bob's Celebi for 110 damage"
```

The damage template spells the defender's possessive with a curly apostrophe
(`Bob’s`); the logs sometimes print a straight one. The parser then falls through
to the shorter `used_attack` template, which happily accepts the rest of the line
as the attack's name. Nothing errors — the hit is simply gone.

It is not an edge case: `slowking-vs-beedrill.log` contains **zero** curly
apostrophes and loses **all six** of its attack lines this way. The other three
fixtures happen to have curly ones, which is why the bug survived three slices of
testing.

**Why it blocks the solver:** a knockout with no preceding damage is exactly the
"unexecutable" contradiction slice 3 would report as a card-data bug. This must be
fixed in the parser (normalise `’` and `'` when matching, or ship both templates)
before any residue measurement, or ~3% of matches will look corrupt.

### F2 — the corpus is single-locale

All 411 logs detect as `en`. That is a fact about this corpus, not about the
product: it means **the localized card-list splitter is still unvalidated**, and
this audit cannot close it. The parser's own README makes the same complaint
about its fixtures. Non-English logs remain the gap that only a non-English
player can close.

### F3 — withdrawn: breakdowns are not arithmetic

An earlier version of this audit reported 28 damage events whose breakdown
components exceeded the printed total, and a rule was written to catch them. It
was withdrawn after reading them: the breakdowns repeat components
(`Base 60, Damage 170, Damage 170, Total 230`), print partials beside a total
(`Weakness 150` against `300`), and sometimes carry `0` legitimately
(`Base 70, Total 0`). No locale-independent arithmetic survives that, so the
breakdown is now carried as printed and asserted against nothing.

This is a finding about the *check*, not the corpus: two successive rules were
falsified by the same data, and the honest conclusion is that a breakdown is
provenance rather than an invariant.

### F4 — one log has no turn header

One game fails to lower: `UnresolvedPlayersError`, which fires only when the log
contains no turn phase at all. That is a truncated or broken export, and refusing
it is correct — but the tracker should surface it as "could not reconstruct"
rather than as a crash. Not investigated individually; it is 1 in 411.

### F5 — `unmodelled` is small but not empty

409 lines fall in `unmodelled` (Special Conditions, effect prevention). At 0.9%
of ignored lines this is not urgent, but the bucket is the work queue the spec
named, and it is now measured rather than guessed.

## What this audit does not answer

The question that motivated the whole design — **how often a board cannot be
confirmed** — needs the world graph and the solver. This audit only proves the
lowering can read the corpus. Nothing here measures divergence, and no rate in
this document should be read as one.

Rates are reported as observed proportions with `n`; the 3.4% carries a Wilson
interval. This is a coverage audit, not a sampled estimate of the player base.

## Verification after the parser fix

The apostrophe fix (parser ADR-0006) was measured on the same 411 games, against
the published parser `1.2.0`:

| | before | after |
|---|---|---|
| `attack` events | 5,348 | 5,165 |
| attacks with a digit in the name | 183 | **0** |
| `damage` events | 2,427 | 2,586 |
| `knockout` events | 1,811 | 1,811 |

Every downgraded line became the damage event it always was. Damage rises by 159
rather than 183 because 24 of them were collapsed as restatements (D21). That
was wrong: they are Festival Lead second attacks, and amended D21 keeps them as
hits (2026-10-27).

The same fix exposed F3 in a fixture: beedrill's recovered damage line carries a
partial breakdown, which is what showed the original equality check to be wrong.
With the rule narrowed to "components cannot exceed the total", the fixture audit
reports **0** suspicious attacks and **0** breakdown diagnostics, so both can run in
CI as regression checks rather than as corpus-only measurements.


The fix ships as a parser minor; this package's exact pin then needs the bump, and
the vendored fixtures' shape projections need refreshing from the new parser.

