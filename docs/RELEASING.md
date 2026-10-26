# Releasing

This is the same tag-triggered, tokenless, provenance-signed procedure as the
other `@dierkens.dev` libraries. The reasoning is in
[ADR-0001](adr/0001-tag-triggered-oidc-releases.md); the workflow file is the
authority, and this file is the procedure.

## The shape

A release is **a tag push**. Everything after it is automated, tokenless, and
provenance-signed by CI (`.github/workflows/release.yml`).

```
changeset  →  pnpm run version  →  commit  →  git tag  →  git push --tags
                                                              ↓
                CI: guards → verify → publish → GitHub Release
```

The dist-tag is derived from the version: anything with a prerelease suffix
(`1.0.0-rc.1`) goes to **`next`**; anything else moves **`latest`**.

## One-time bootstrap

Trusted publishing cannot create a package — it can only be configured for a
package that **already exists**. So the very first publish is manual, and it is
a throwaway placeholder rather than the real first release (which would
otherwise ship without provenance).

1. **Create the package.** Temporarily set `"version": "0.0.0"` in
   `package.json`, then:

   ```sh
   npm publish --access public
   ```

   `prepublishOnly` runs the gate here; that is fine and fast. Revert the
   version afterwards — do not commit it. Note that this works with a dirty
   working tree: npm has no publish-branch check, unlike pnpm. Your npm must be
   >= 11.5.1 (check with `npm -v`).

2. **Configure the trusted publisher** at
   <https://www.npmjs.com/package/@dierkens.dev/ptcgl-battle-log-state/access>
   for the `Release` workflow in this repository. Two things to get right:
   - Tick **"Allow npm publish"**. Configurations created after 2026-09-03
     default to *stage-only*, which would require a per-release approval on
     npmjs.com.
   - Complete a publish **within 2 days** or the configuration expires and must
     be recreated. Do step 3 in the same sitting.

3. **Create the GitHub environment** named `npm` (Settings → Environments) and
   add yourself as a required reviewer. The publish job uses it, so a release
   needs both the tag and an approval.

## Routine release

```sh
pnpm changeset           # describe the change
pnpm run version         # applies changesets → package.json + CHANGELOG.md
pnpm run verify          # the FULL gate — see below
git add -A && git commit -m "chore: release vX.Y.Z"
git tag vX.Y.Z && git push origin main --tags
```

## Rehearsing on a prerelease

A first release should be exercised on a prerelease, so that a mistake lands on
`next` rather than on `latest`. Changesets drives the whole thing:

```sh
pnpm exec changeset pre enter rc
pnpm run version                    # consumes the changesets → 1.0.0-rc.0
pnpm run verify
git add -A && git commit -m "chore: version 1.0.0-rc.0"
git tag v1.0.0-rc.0 && git push origin main --tags
```

CI publishes `1.0.0-rc.0` to `next`. **Check that it did what it claims** before
going further — the point of the rehearsal is to find out here:

```sh
npm view @dierkens.dev/ptcgl-battle-log-state dist-tags   # next → 1.0.0-rc.0, latest untouched
npm view @dierkens.dev/ptcgl-battle-log-state@1.0.0-rc.0 dist.attestations
```

The npm page should show a provenance attestation on the version. Then promote:

```sh
pnpm exec changeset pre exit
pnpm run version                    # → 1.0.0
git add -A && git commit -m "chore: release v1.0.0"
git tag v1.0.0 && git push origin main --tags
```

`pnpm run verify` is `typecheck && lint && test:coverage && build`. It is what
CI runs and what `prepublishOnly` runs, so the same gate runs locally and in
the pipeline.

## GitHub Releases

After a successful publish, CI creates a GitHub Release for the tag — in a
separate job, because creating one needs `contents: write` and the job that
authenticates to npm should not have it.

The notes are the CHANGELOG section for that version, extracted by
`scripts/changelog-section.mjs`. Same text as the changelog, so there is no
second summary to keep in sync; the step fails rather than posting empty notes.
Prereleases are marked as prereleases, final releases become the repository's
latest release, and the step is idempotent so a re-run updates the notes instead
of failing on "release already exists".

## What is automated, and what is not

**Automated:** verification, the build, the dist-tag choice, provenance
attestation, the upload, the GitHub Release.

**Manual:** deciding the version bump, pushing the tag, and 2FA for the one-time
bootstrap. There is no `NPM_TOKEN` in the repository, and there should never be
one.

## Gotchas

- **Never set `registry-url:`** on the publish job's `setup-node`.
  `actions/setup-node` then writes an empty `_authToken` line, npm reads that as
  "auth is configured", and the OIDC exchange never starts. It fails as
  `ENEEDAUTH` or a misleading 404.
- **`--provenance` is unnecessary.** Trusted publishing attaches the attestation
  automatically. Passing the flag is not wrong, just redundant.
- **`npm whoami` is not a valid check** that trusted publishing is configured.
  The only valid check is performing the intended operation.
- **The publish is `npm publish`, and it needs npm >= 11.5.1.** pnpm does not
  implement OIDC itself — `pnpm publish` shells out to npm
  ([pnpm/pnpm#9812](https://github.com/pnpm/pnpm/issues/9812)) — so the npm CLI
  is what authenticates either way. The workflow installs it explicitly, and
  uses `npm publish` directly so the path does not depend on pnpm's delegation.
  The Node version matters only because npm needs a recent-enough runtime.
- **No `--no-git-checks` anywhere.** It exists because pnpm refuses to publish
  from a detached HEAD, which is what a tag checkout always is. npm has no such
  check, so switching to `npm publish` removed the need for the flag rather than
  working around it.
- **`.npmrc`'s `access` setting is not what makes it public.** pnpm reads only
  auth and registry settings from `.npmrc`; visibility comes from
  `publishConfig.access` in `package.json` and the explicit `--access public`.
  (npm *does* honour `access` in `.npmrc`, which is why it works locally — but
  do not rely on that.)
- **Republishing an unpublished name is blocked** for ~24 hours. Irrelevant for
  the scoped name, which has never been published.
