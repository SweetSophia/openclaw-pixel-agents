# npm onboarding implementation plan

Status (2026-10-26): source and package qualification complete in [PR #315](https://github.com/SweetSophia/openclaw-pixel-agents/pull/315). That PR did not deploy or publish; current rollout and a separate future npm release remain explicit entries in [revamp status](../../revamp-status.md).

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make installation and first use explain how to configure and start Pixel Agents.

**Architecture:** Keep argument dispatch in the existing launcher and place the shared, static setup guide in `bin/setup.mjs`. A standalone, output-only install script supplies a short pointer; package smoke tests exercise the real installed entrypoints.

**Tech Stack:** Node ESM, node:util argument parsing, Vitest child-process tests and the existing npm tarball smoke.

**Spec:** `docs/superpowers/specs/2026-10-26-npm-onboarding-design.md`

## Global constraints

- Node `^22.22.2 || ^24.15.0 || >=26.0.0`; no new dependencies.
- No automatic env-file writes, key generation, pairing, server start or network requests from setup/install notice.
- Preserve configured startup and environment precedence; missing startup configuration remains a nonzero exit.
- Preserve README screenshot markup and both image files.

## Review focus

- Unknown positional commands or mixed setup/startup flags must not start the office or load credentials.
- Missing/blank CORS must produce guidance without creating data; malformed explicit env-file paths remain actionable failures.
- Help/version/key output must not expose configured secrets; key/version remain machine-readable.
- Ignored lifecycle scripts must not remove access to setup; an enabled install hook must work from the published allowlist.
- A configured disposable installation must still serve assets and retain appearances after restart.

### Task 1: Launcher guidance

**Files:** Create `bin/setup.mjs`; modify `bin/openclaw-pixel-agents.mjs`, `server/packageCommand.test.ts` and `README.md`.

- [x] Add real-process regressions for setup, missing/blank config, unsupported commands/flag combinations, missing env file and secret-safe unchanged key/version output.
- [x] Run `npm test -- server/packageCommand.test.ts` and confirm the new behavior fails before implementation.
- [x] Add static setup instructions and explicit command dispatch. After env-file loading, fail with guidance if CORS is missing; retain configured server startup.
- [x] Update targeted README instructions, preserving images. Run the focused tests and commit the working launcher slice.

### Task 2: Install notice and real package

**Files:** Create `scripts/install-notice.mjs`; modify `package.json`, `package-lock.json`, `scripts/smoke-package.mjs` and `CONTRIBUTING.md`.

- [x] Extend the tarball smoke's exact file policy and consumer checks to require setup, first-run recovery and an enabled foreground install notice; verify failure before implementation.
- [x] Add the output-only postinstall script and exact runtime file allowlist entries. Reconcile lockfile metadata without changing dependencies.
- [x] Verify script-disabled setup and configured consumer startup, assets, key generation, ingest and restart persistence; verify enabled notice in a separate isolated install.
- [x] Run typecheck, coverage, build, package smoke, both audits, documentation links and README/image preservation checks. Review and commit; open a PR and address valid review feedback before merge. A new npm publication is a separate release step.
