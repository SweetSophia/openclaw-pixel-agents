# Publish an npm release

The package name is `openclaw-pixel-agents`. Merging a pull request or pushing a tag alone does not publish it. The workflow runs only when a **stable GitHub Release is published**.

## One-time setup

1. Confirm your npm account can publish the package name. A registry 404 does not reserve it. First publication establishes ownership; later versions require an owner or authorized maintainer.
2. Create a granular npm token with **Read and write (publish and stage)** package permission. Enable **Bypass two-factor authentication** for unattended publishing, set an expiration, and restrict it to this package once it exists. A stage-only token cannot run this workflow. For the first unscoped publication, ensure your token can create the name; if your token policy cannot authorize creation, publish the first version interactively and then scope the CI token to it. See [npm's token instructions](https://docs.npmjs.com/creating-and-viewing-access-tokens/).
3. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**. Name it exactly **`NPM_TOKEN`** and paste the token as its value. Do not commit or share the token in chat.

The token reaches only the final publish step. The workflow requests an OIDC identity for npm provenance and never runs on pull requests.

## Prepare a version

1. Update `package.json` and the root entry in `package-lock.json` together in a pull request. `npm version <version> --no-git-tag-version` can do this. Add `docs/releases/<version>.md` to the same pull request with that version's release notes. Update README installation examples and version-specific availability notices for the version being published. The first npm release was `1.4.0`, continuing the existing GitHub release series after `v1.3.5`. Results/Files arrived in `1.5.0`, Workspace in `1.6.0`, and [1.7.0](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/docs/releases/1.7.0.md) adds Usage, onboarding instructions and transient Gateway-startup recovery.
2. Run the checks:

   ```sh
   npm ci
   npm run typecheck
   npm run test:coverage
   npm run build
   npm run test:package
   npm audit --omit=dev --audit-level=high
   npm audit --audit-level=moderate
   ```

3. Merge after required checks and reviews pass.
4. Create a **draft** GitHub Release targeting the merged `main` commit, with a tag exactly matching the version, e.g. **`v1.7.0`**. Copy the matching `docs/releases/<version>.md` into the release body (for this release, `docs/releases/1.7.0.md`). Finalize and review the notes before publishing the stable release, which triggers npm publication. Drafts and prereleases do not publish to npm.

Publishing the release authorizes npm publication. Protect release tags and restrict release publishing according to the repository's maintainer policy.

## What gets published

Version-specific notes live in `docs/releases/` on GitHub. Their installation examples pin that exact release; general README examples select compatible updates. Copy the notes into the GitHub Release body as described above; the publish workflow does not do this automatically. They are not included in the npm package; the README links to them on GitHub. The package includes the installation, configuration, editor, task-access and publishing guides.

[The workflow](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/.github/workflows/publish.yml) verifies tag/version equality and `main` ancestry, then installs, type-checks, tests coverage, builds and audits.

It packs the built app using a file allowlist, installs that actual tarball with production dependencies in an empty directory, and checks the launcher, key generation, HTML, sprites, ingest and appearance persistence after a process restart. All smoke data and credentials are synthetic; no real OpenClaw task is sent.

It then publishes **the same tested tarball** to the public npm registry with provenance and the `latest` dist-tag. Publication skips lifecycle scripts because that tarball is already built and tested. Normal local `npm pack` builds through `prepack`; installation does not build or start the office.

## Confirm publication

Check Actions, then verify the registry separately, substituting the released version:

```sh
npm view openclaw-pixel-agents@1.7.0 version dist.integrity dist.tarball
npm exec --yes --package=openclaw-pixel-agents@1.7.0 -- openclaw-pixel-agents --version
```

Metadata and tarball availability can propagate separately. Allow a short bounded retry after an accepted upload; never republish an accepted immutable version. A successful upload alone does not prove that the public package installs. If a run fails during publication, check whether npm accepted the version before retrying. Corrected artifacts need a new version.

## Optional tokenless publishing

After establishing the package, [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) can authorize GitHub owner `SweetSophia`, repository `openclaw-pixel-agents`, workflow filename `publish.yml`, with direct `npm publish` permission. This requires npm 11.5.1+. Migrate the workflow's token-required check and authentication configuration before removing the secret, then verify OIDC publication. The checked-in workflow currently expects `NPM_TOKEN`.
