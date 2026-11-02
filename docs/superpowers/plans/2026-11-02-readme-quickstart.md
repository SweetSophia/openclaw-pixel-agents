# README Quickstart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let end users find and follow the prebuilt npm install/configure/start path before encountering developer source-build instructions.

**Architecture:** Reorganize the README and add a short getting-started path to the existing configuration reference. Reuse the launcher and setup guide unchanged; keep deep settings and deployment alternatives linked rather than duplicate the complete reference.

**Tech Stack:** GitHub Markdown, existing Node.js/npm launcher and repository verification commands; no new dependencies.

**Spec:** [User-first installation documentation](../specs/2026-11-02-readme-quickstart-design.md).

## Global Constraints

- Documentation-only; no runtime/package/version/dependency/launcher/roster/permission changes.
- Supported Node.js range: `^22.22.2 || ^24.15.0 || >=26.0.0`.
- Minimal user configuration: `PORT=3001`, `CORS_ORIGIN=http://localhost:3001`, `DATA_SOURCE=cli`; startup `openclaw-pixel-agents --env-file ./pixel-agents.env`; browser `http://localhost:3001`.
- Preserve existing public README anchors and security/private-access/storage boundaries.
- Guided installer and configurable roster remain separate follow-ups.
- No global installation, real configuration/key/grant changes, Gateway calls, deployment or npm publication during verification.
- Preserve the primary checkout's existing dirty `.gitignore` and unrelated worktrees. Use the clean isolated checkout on `codex/readme-quickstart-20261102`, based on `d652338`.

## Review Focus

- A reader with no repository checkout must receive every required configuration value before startup, with no missing `.env`-loading step.
- A remote-OpenClaw user must not mistake local CLI polling or roster updates for a Gateway/private-access connection.
- Package upgrades must not redirect persistent data into a temporary install or relative working-directory path.
- Existing links to moved source/npm/key instructions must still resolve.
- npm users must not be promised unreleased source features or automatic arbitrary-roster discovery.

## Task 1: Reorganize and verify the user onboarding path

**Files:**
- Modify: `README.md`.
- Modify: `docs/configuration.md`.
- Update completion/verification notes in this plan after execution.

**Interfaces:**
- Consumes: existing `bin/openclaw-pixel-agents.mjs` flags, `bin/setup.mjs` instructions, `.env.example`, `package.json#engines`, collector/private-access docs.
- Produces: a user-facing install/configure/start tutorial plus a linked configuration reference; no new executable API.

- [x] **Step 1: Establish the documentation checks before editing.**

  Capture current README headings/anchor targets and configuration introduction. Use a temporary Node assertion check for the intended ordering: quickstart before `What you can do`, npm/config/start examples before `Start from source`, and source build instructions near `Development and releases`. Confirm the current README fails the new ordering assertion. Keep the checker temporary; do not introduce a documentation-test framework.

- [x] **Step 2: Update the two documentation surfaces as one coherent path.**

  Put a recommended npm quickstart immediately after the short introduction/screenshots. Include prerequisites, installation/version check, the complete minimal file, file-location/private-permission guidance, explicit startup, URL and Ctrl+C. Explain the persistent launcher default and local-source assumptions; link remote setup, optional private pairing, reference/troubleshooting and the fixed-roster limitation. Keep npm/setup anchors and explain that `setup` prints guidance rather than creating files. Move source development/production-build instructions near the bottom without losing their anchors or commands. Add the matching minimal-start section to `docs/configuration.md`, put npm before source startup examples, and retain the existing reference table and advanced sections.

- [x] **Step 3: Close the five review-focus checks.**

  Run the ordering/minimal-value assertions to PASS. Verify all previous README heading anchors still exist; resolve every local Markdown link and fragment in both modified files. Check the new CLI flags/defaults against the real launcher and read-only `--help`/`setup` output. Inspect the remote-source/private-access distinction, storage defaults and version/roster limitations explicitly; do not infer correctness from link checks alone.

- [x] **Step 4: Run proportionate and repository-required verification.**

  Run `git diff --check`, `npm ci`, `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=moderate`. The package smoke uses disposable synthetic data and must not contact a real Gateway or publish. Record exact commands/results; distinguish a prose/link pass, synthetic startup and real-user acceptance. A failure remains visible and must be assessed, not silently excluded. Confirm only the intended documentation and planning files changed.

- [ ] **Step 5: Review and hand off.**

  Obtain a focused whole-diff review of the docs against the approved spec and actual launcher/reference contract. Before any commit or GitHub write, verify `gh api user --jq .login` is exactly `SweetSophia`. Keep the change on the docs branch; report local verification and any residual limitations. No main merge, deployment, new release or unrelated feature delivery is implied by this documentation task.

## Planning self-review

The single task owns both coupled docs surfaces and every review-focus check; there are no runtime interfaces to coordinate. Existing English Markdown/anchors are retained. At the planning checkpoint, the registry had been queried read-only and help/setup run without starting the office; implementation and the full gate were still pending. The user subsequently approved Native execution: one small coupled documentation change followed by a fresh focused reviewer.

## Execution record

The docs-only implementation retains every prior README heading anchor, resolves 35 local/repository links and preserves the configuration reference table and advanced sections byte-for-byte. Temporary ordering checks observed the original missing-quickstart failure and then passed; no permanent prose-test framework was added.

Fresh local checks on Node 26.4.0 / npm 12.1.0 passed: `npm ci`, typecheck, all 1,880 tests in 125 files, coverage, build, package installation/startup smoke, both audit gates and `git diff --check`. Coverage was 85.67% statements, 83.80% branches, 88.14% functions and 88.46% lines; thresholds were unchanged. The package smoke checked 185 packed files, script-disabled setup, the enabled install notice, assets and restart persistence. Existing Vite configuration/chunk warnings, fixture diagnostics and npm's blocked esbuild install-hook notice were retained, not treated as failures or silently suppressed.

An additional disposable probe parsed both documented configuration examples, exercised the real built launcher with a relative env-file path from a folder containing spaces, and checked production SPA/status/default-layout responses and on-demand storage in a temporary home. It verified documented environment precedence using an isolated port/origin; the CLI was deliberately unavailable and no real Gateway settings were inherited. The probe stopped its own child and removed its temporary state. Initial helper-only assumptions about `parseEnv` object prototypes and storage creation at startup were corrected and their failure evidence retained; no runtime fix was made or live agent/private-access acceptance claimed.

Independent whole-diff review and the final local handoff remain the last task gate. No GitHub push, main merge, deployment or npm publication has occurred for this documentation task. The guided installer and configurable roster remain separate follow-ups.
