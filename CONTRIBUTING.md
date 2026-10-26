# Contributing

Thanks for looking. This is a small, focused package. The bar is: one behaviour,
pinned by a test, with the reasoning written down.

## Getting set up

```sh
git clone https://github.com/cdierkens/ptcgl-battle-log-state
cd ptcgl-battle-log-state
pnpm install
pnpm run test        # vitest run, with coverage
```

Needs Node >= 22.12.0 and pnpm (`corepack enable` if you don't have it).

## The most valuable contribution

**A battle log where the reconstruction is wrong rather than uncertain.** The
package is allowed to say `divergent` — that is a result. What it must never do
is produce a confident, wrong board, or an `unexecutable` document from a log
the game actually played. Both are bugs, and both need the log plus the line
number to be actionable. See the [wrong-board issue
template](./.github/ISSUE_TEMPLATE/wrong-board.yml).

If you are wondering what to attack: the duplicate-name case is where this gets
hard, and two cards sharing a name are common in real decks.

## Conventions

- **No guessing.** When the log cannot split two identical cards, the document
  says `divergent` and carries both. A resolved-looking board that was picked by
  a heuristic is the one bug this package cannot recover from, because the
  evidence is in the log but the assumption is not.
- **Errors are values.** Fallible functions return a `Result`. They do not
  throw, and there are no `*OrThrow` twins — `unwrap` is the throwing surface.
- **The parser pin is exact, on purpose.** The lowering table is total over the
  parser's template keys; an upstream minor that adds a key must fail this
  build loudly. Bumping the pin is a deliberate change with a changeset.
- **Public API changes go through Changesets**, never a hand-edited
  `CHANGELOG.md`: `pnpm exec changeset`.
- **Comments explain *why*.** The code already says what it does.

## Before you open a PR

```sh
pnpm run verify
```

That is `typecheck`, `lint`, `test:coverage` and `build` — the same thing CI
runs, plus a smoke job that installs the packed tarball in a clean directory.
Nothing here needs a Pokémon TCG Live install.

Releases are automated from a tag; contributors never publish. See
[docs/RELEASING.md](./docs/RELEASING.md).

## Reporting a bug

Include the battle log (with player handles replaced by neutral stand-ins —
the other player has not agreed to appear in a public issue), the line the board
went wrong at, and what you expected to see. A reconstruction that cannot be
traced to a line cannot be fixed.
