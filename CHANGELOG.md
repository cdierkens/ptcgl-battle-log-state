# Changelog

## 0.1.0

### Minor Changes

- First release: reconstruct board state from a battle log, and say so when the log
  cannot settle it.
  
  - `ptcgl-state/1` — the document contract and `validateDocument`, which enforces
    the invariants JSON Schema cannot: candidates carry the same multiset of values,
    `divergent` actually diverges, a slot in a group holds no smuggled values, and
    every slot belongs to exactly one board.
  - The lowering pass — a total map from the parser's 228 template keys to a
    locale-free event IR (66 mapped, 162 ignored with a reason, `unhandled` failing
    the build). Collapses restatements, attaches damage breakdowns, and records card
    names verbatim.
  - The coverage audit — run over 411 stored games: 0 parse failures, 0 unhandled
    keys, 183 attacks whose damage a parser template mismatch had swallowed.
  
  Requires `@dierkens.dev/ptcgl-battle-log-parser` 1.2.0, pinned exactly.

Managed by [changesets](https://github.com/changesets/changesets). Entries are
written by `pnpm changeset` and applied by `pnpm run version`; do not edit this
file by hand.
