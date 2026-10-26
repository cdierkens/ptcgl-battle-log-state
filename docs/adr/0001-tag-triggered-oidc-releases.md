# 1. Releases are a tag push through npm trusted publishing

Date: 2026-10-26
Status: Accepted.

## Context

This package publishes to npm, where a wrong publish cannot be undone: the
version is burned, and a wrong artefact under `latest` reaches installers before
anyone can react. So the question is not "how do we run `npm publish`" but
"where does the authority to publish live, and what stops a mistake".

A long-lived npm token in CI is the default answer and the wrong one. It is a
credential with scope-wide blast radius, it lives in repository secrets, and it
has to be rotated by hand. npm's trusted publishing replaces it with an OIDC
exchange between GitHub Actions and npm, and attaches a provenance attestation
tying the artefact to the commit and workflow that built it.

## Decision

**A release is a `v*` tag push.** `.github/workflows/release.yml` is the
authority; `docs/RELEASING.md` is the procedure.

The publish job has:

- **No `NPM_TOKEN`.** `id-token: write` is the only extra permission, and only
  on that job; the workflow's default is `contents: read`.
- A GitHub **environment** (`npm`) with a required reviewer, so a tag alone is
  not enough to publish.
- **Two guards before the irreversible step:** the tag must equal
  `package.json`'s version, and the tagged commit must be an ancestor of `main`.
  Neither failure is recoverable after the fact, so both are checked before it.
- **`npm publish`, not `pnpm publish`**, with the npm CLI installed explicitly
  at `>= 11.5.1`.
- **No `registry-url:`** on `setup-node`, and no `--provenance` flag.

The dist-tag is derived from the version: anything with a prerelease suffix goes
to `next`, everything else moves `latest`.

The GitHub Release is a **separate job** with `contents: write`, running only
after the publish succeeds, with notes extracted from the changelog section for
that version.

Actions are pinned to commit SHAs; Dependabot updates them monthly as one
grouped PR.

## Consequences

- The gate runs twice: `prepublishOnly` runs `verify` at publish time, and CI
  runs `verify` on the pull request. The publish job trusts the tag, not the PR.
- A trusted-publisher configuration must be used within two days of being
  created, or it expires and has to be recreated.
- Prereleases are how a new package is rehearsed, because `next` is recoverable
  in a way `latest` is not.
- The guards catch a mismatched tag and a tag on the wrong branch. Neither can
  catch a wrong-but-consistent version. That stays a human decision, deliberately.

## Alternatives considered

- **Publish locally.** Rejected: no provenance, the artefact is built from
  whatever dirty tree the maintainer had, and the reviewer gate disappears.
- **`NPM_TOKEN` in repository secrets.** Rejected: long-lived credential,
  scope-wide blast radius, manual rotation. Trusted publishing exists to delete it.
- **`pnpm publish`.** Rejected: pnpm shells out to npm for OIDC anyway
  ([pnpm/pnpm#9812](https://github.com/pnpm/pnpm/issues/9812)), so it adds a
  delegation step without changing who authenticates.
- **`changesets/action` to publish.** Rejected for now: it drives a release PR
  with `GITHUB_TOKEN` and its own publish path, which puts a second actor
  between the tag and the registry. Tag-triggered is one actor, one event.
- **Passing `--provenance` explicitly.** Redundant: trusted publishing attaches
  the attestation automatically. Not wrong, just a flag that implies a step that
  is not happening.

## Notes

- `actions/setup-node` writes an empty `_authToken` line when `registry-url:` is
  set. npm reads that as "auth is configured", never starts the OIDC exchange,
  and fails as `ENEEDAUTH` or a misleading 404.
- The npm runtime floor is about npm itself, not the package: Node 22.14 ships
  npm 10.x, which does not understand OIDC at all. The workflow installs npm
  rather than assuming the version a Node release happens to bundle.
