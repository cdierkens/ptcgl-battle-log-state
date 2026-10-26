# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/cdierkens/ptcgl-battle-log-state/security/advisories/new)
instead, with a reproduction if you can.

You should get an answer within a few days. This is a small project maintained
by one person, so please allow for that.

## Scope

Useful context when you're assessing this package:

- **One runtime dependency:** `@dierkens.dev/ptcgl-battle-log-parser`, pinned to
  an exact version. It is the input language, not an adapter, and the exact pin
  means an upstream release cannot reach this package without a deliberate bump
  and a changeset. Nothing else is transitive.
- **No network access, no filesystem access, no dynamic code.** A document is
  validated in memory; nothing is fetched or executed.
- **No install scripts**, so `npm install` runs none of this package's code.
- **Releases are published from CI via npm trusted publishing (OIDC)**, with a
  provenance attestation attached automatically. There is no long-lived npm
  token in the repository or in CI. See
  [ADR-0001](./docs/adr/0001-tag-triggered-oidc-releases.md).

So the realistic risk surface is the pinned parser dependency — which is why the
pin moves by hand, never by a scheduled PR — and the release pipeline itself.
