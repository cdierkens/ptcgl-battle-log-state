# ptcgl-battle-log-state

Reconstruct Pokémon TCG Live board state from a battle log, and say so when the
log cannot settle it. Published to npm as `@dierkens.dev/ptcgl-battle-log-state`
(MIT, public).

Public API and provenance: `README.md`. Design:
[`docs/specs/2026-10-25-duplicate-card-identity.md`](docs/specs/2026-10-25-duplicate-card-identity.md)
and [`docs/specs/2026-10-25-state-format.md`](docs/specs/2026-10-25-state-format.md).

## Commands

- `pnpm run verify` — the gate: `typecheck`, `lint`, `test:coverage`, `build`.
  This is what CI runs, and what `prepublishOnly` runs.
- `pnpm changeset` / `pnpm run version` — changesets.
- **Releasing is automated from a tag.** `docs/RELEASING.md` is the procedure;
  `docs/adr/0001-tag-triggered-oidc-releases.md` is the reasoning.

## Docs

- `GLOSSARY.md` — the vocabulary. Use its terms; avoid the listed synonyms.
- `docs/specs/` — the package's contract and design. Approved.
- `docs/adr/` — decisions that bind new work.
- `docs/audits/` — dated measurements, with the method and the numbers. The specs cite the latest.

## Constraints

- **One runtime dependency: `@dierkens.dev/ptcgl-battle-log-parser`, pinned
  exactly.** Not a range. The lowering table is total over the parser's template
  keys, and a parser minor that adds a key must fail this package's build loudly
  rather than slip through — an exact pin makes that failure explicit, and moving
  it is a deliberate act with a changeset. Everything else is a devDependency.
- Plain TypeScript library. Not a PokeDojo package. No Effect, no
  `@pokedojo/types`, no Firestore, no React Router, no Turborepo.
- **No guessing.** When the log cannot split two identical cards, the document
  says `divergent` and carries both. A resolved-looking board that was picked by
  a heuristic is the one bug this package cannot recover from.
- Error handling is a `Result` union — not `try/catch`. `unwrap` is the only
  place a failure becomes an exception; there are no `*OrThrow` twins.
- Public API changes go through Changesets (`.changeset/`), not manual
  `CHANGELOG.md` edits.
- Releases publish from CI via npm trusted publishing (OIDC), with provenance
  attached automatically. There is **no `NPM_TOKEN`**, and there should never be
  one.

## Agent skills

`skills-lock.json` is committed; the installed `.agents/` tree is **not** (it is
gitignored and reproducible). Restore it with `npx skills update`, and review the
diff.
