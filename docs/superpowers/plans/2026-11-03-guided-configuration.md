# Guided Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate safe, previewed local/remote office configuration with optional private access, without modifying an existing installation.

**Architecture:** A separate Node CLI command collects answers, builds validated configuration, then exclusively writes a new private bundle after confirmation. Pure configuration policy, filesystem mutation and terminal interaction have separate modules; server and collector behavior stays unchanged.

**Tech Stack:** Existing Node ESM CLI, Node built-ins, Vitest node-environment tests, existing tarball smoke test. No new dependencies.

**Spec:** [Guided configuration design](../specs/2026-11-03-guided-configuration-design.md).

## Global Constraints

- No new dependencies or server/browser APIs; Node `^22.22.2 || ^24.15.0 || >=26.0.0`.
- Keep `setup` read-only; no automatic startup, CLI execution, pairing, grants, network probes or write controls.
- Create-only bundles preserve existing files, settings and credentials; require preview and affirmative confirmation.
- No npm publication or live deployment. Fixed roster remains a separate follow-up.
- New directory/file POSIX modes `0700`/`0600`; explain Windows ACL limitations.
- No ambient secret defaults or secret terminal output; generated ingest and office keys are separate random 32-byte values.

## Review Focus

- Existing/dangling-symlink destination or concurrent creator: refuse without changing any prior contents (Task 1).
- Dotenv metacharacters, quotes, Windows-style backslashes and control characters: exact round-trip or explicit rejection, never injection (Task 1).
- EOF/Ctrl+C/non-TTY/declined confirmation: no created configuration or started process (Task 2).
- Public origin differs from collector base URL behind a proxy: keep them distinct and match collector transport policy (Tasks 1 and 2).
- Installed tarball rather than source checkout: all imports and commands work with install scripts disabled, secrets remain out of logs (Task 2).

---

### Task 1: Validated configuration and exclusive bundle writer

**Files:** Create `bin/configure-values.mjs`, `bin/configure-files.mjs`, `server/configureValues.test.ts`, `server/configureFiles.test.ts`.

**Interfaces:**
- `buildConfiguration(answers, { home, cwd })` consumes plain validated-answer candidates and returns `{ directory, files, preview, mode, privateAccess }`; `files` maps fixed filenames to dotenv strings. Answers use `mode`, `port`, `origin`, `dataDir`, `directory`, `openclawBin`, `collectorUrl`, `privateAccess`, `gatewayUrl`.
- `writeConfigurationBundle({ directory, files })` synchronously creates only that new directory/files; returns absolute written paths or throws a sanitized failure. No existing parent creation.
- `dotenvValue(value)` returns a safely quoted, round-tripping dotenv scalar or rejects unsupported/control-containing text. `preview` never contains actual generated keys.

- [x] **Step 1: Write failing value/contract tests.** Assert local defaults produce `DATA_SOURCE=cli`, remote maps `INGEST_API_TOKEN === PIXEL_INGEST_TOKEN`, keys match `/^[a-f0-9]{64}$/` and differ, optional access defaults disabled, enabled access has all three write/exception flags `false`, and no bootstrap credentials are included. Test port bounds, credentialed/path-bearing origins, URL transport/query/fragment rejection, absolute/relative paths, dotenv metacharacters/backslashes/quote combinations/control text. Parse generated values with `parseEnv`, compare Gateway acceptance with `loadControlConfig`, and collector acceptance with `getIngestEndpoint`.
- [x] **Step 2: Run `npm test -- server/configureValues.test.ts` and record expected failures because the builder is absent.**
- [x] **Step 3: Implement `buildConfiguration` and `dotenvValue`.** Reuse the side-effect-free collector validator import, use `randomBytes(32).toString('hex')`, and keep absolute path interpretation platform-native. Never import the compiled server into the wizard.
- [x] **Step 4: Run value tests and confirm all cases pass.**
- [x] **Step 5: Write failing filesystem tests.** Use temporary directories; assert existing regular/nonempty/empty/dangling-symlink destinations remain unchanged, two writes cannot clobber, permissions exclude group/other on POSIX, missing parent creates nothing, and a controlled filesystem write failure cleans only owned artifacts. Reject unexpected file-map names to prevent traversal.
- [x] **Step 6: Run `npm test -- server/configureFiles.test.ts` and record expected missing-writer failures.**
- [x] **Step 7: Implement `writeConfigurationBundle`.** Exclusive `mkdirSync` followed by fixed-name `writeFileSync` with `flag: 'wx'`; cleanup tracks only successful own writes and uses nonrecursive removal. Do not remove a pre-existing destination on any failure. Do not print serialized contents in errors.
- [x] **Step 8: Run `npm test -- server/configureValues.test.ts server/configureFiles.test.ts`, then `npm run typecheck`; commit the focused deliverable.**

### Task 2: Interactive command, packaged delivery and user guidance

**Files:** Create `bin/configure.mjs`, `server/configureCommand.test.ts`; modify `bin/openclaw-pixel-agents.mjs`, `bin/setup.mjs`, `package.json`, `scripts/smoke-package.mjs`, `server/packageCommand.test.ts`, `README.md`, `docs/configuration.md`, `collector/README.md`, and `CONTRIBUTING.md` only where new-command verification instructions belong.

**Interfaces:**
- `runConfigure({ ask, output, home, cwd })` runs the session; `ask(question)` resolves a line or rejects cancellation/EOF, `output(text)` prints only non-secret text. Returns normally on refusal and after successful write; validation repeats the relevant prompt.
- `configure()` owns real terminal checks/readline lifecycle, delegates to `runConfigure`, and closes terminal resources on every exit. No test-only production seams beyond these natural terminal boundaries.
- Consumes Task 1's exact builder/writer results. Launcher dispatches only a sole `configure` positional command with no startup/key/version options; `configure --help` prints command usage without needing a TTY or creating files.

- [x] **Step 1: Write failing session and child-process tests.** Cover both modes, changed port/origin defaults, remote URL separate from browser origin, optional private access and skipped access, redacted preview before confirmation, default-no save, retry after invalid input, EOF/rejected ask, non-TTY rejection, and invalid mixed options. Assert no secret contents/ambient credentials appear in output, no server is imported/started, no executable/network is invoked, and paths with spaces/apostrophes are safe in printed commands.
- [x] **Step 2: Run `npm test -- server/configureCommand.test.ts server/packageCommand.test.ts` and record failures for the missing configure command.**
- [x] **Step 3: Implement the prompt session and terminal adapter; minimally extend launcher parsing/help.** Keep generated secrets out of questions/defaults/preview, generate no files until affirmative confirmation, reject terminal control input, handle Ctrl+C/EOF promptly without unhandled rejections. Explain origin versus listener binding, environment overrides, remote transfer, private key retrieval and explicit manual pairing.
- [x] **Step 4: Run all new CLI tests plus `npm test -- server/packageCommand.test.ts` to preserve legacy setup/startup/option behavior.**
- [x] **Step 5: Extend the exact package allowlists and tarball smoke assertions.** Include only the three new CLI modules; keep existing private-file exclusions. Installed `configure --help` must work and a non-TTY invocation must fail without writing. Add a real PTY smoke using synthetic answers in a private temporary consumer; inspect the saved env file, start the actual installed launcher with that generated configuration in an isolated loopback fixture, and verify `/api/status` and SPA startup. Abort/refusal must leave no bundle. Do not make CI depend on a platform-specific PTY command; document the manual probe where necessary.
- [x] **Step 6: Update docs and static setup guide.** Introduce the interactive alternative beside the existing manual quickstart, preserve old anchors, show source-checkout invocation and collector `node --env-file ... --dry-run` on the correct host. State the command is unreleased until a new package is published, existing published manual instructions still work, create-only semantics, private permissions/Windows warning, no automatic pairing and unchanged fixed roster. Do not imply merging publishes or deploys.
- [x] **Step 7: Run full gate.** `npm ci`, `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate`; inspect link targets and run both real-terminal flows/cancellation in disposable fixtures. Record counts, failures and warnings rather than inferring success from excerpts. No real Gateway or OpenClaw-host credentials.
- [x] **Step 8: Commit explicit files; request one fresh whole-branch review and fix validated findings with regressions.** Follow protected PR workflow with exact pushed head, reset 15-minute review window after updates, assess bot findings against source/tests, and verify exact post-merge CI before claiming delivery. Publication and deployment stay separate.

## Self-review and evidence limits

Both approved modes, private access, preview, create-only preservation and read-only
setup map to tests above. URL policies, terminal boundaries, package inclusion and
filesystem failures are independently observable. Real-terminal/package probes are
stronger than mocked prompt tests and are required for the interaction claim; no
synthetic probe establishes a successful real Gateway pairing or remote deployment.
The design and plan are implementation guidance, not completed-feature evidence.

## Local execution record — 2026-11-03

Native implementation completed in two slices plus one independent-review fix
pass. Review identified two Important issues: Git-visible default secret storage
and remote executable paths interpreted using the dashboard OS. Regression-first
fixes moved the default bundle under the user's home and accepted fully absolute
POSIX/Windows-drive/UNC remote paths; local path checks remain platform-native.

Final local gates: `npm ci`, typecheck, 128 files / 1,956 tests, coverage (85.67%
statements, 83.80% branches, 88.14% functions, 88.46% lines), build, actual 188-file
tarball installation/startup/assets/generated-config ingest/restart, and both
audits passed with zero vulnerabilities. Real-terminal local/private and
remote/private saves, default-no, Ctrl+C and EOF passed from source and the
installed tarball. Local documentation targets were checked. These are synthetic
fixtures, not live Gateway, Windows-host or deployment acceptance.

One Minor finding remains deferred: a collector URL containing both literal quote
kinds can pass its field prompt, then fail final dotenv serialization without
writing files, requiring the user to rerun. No security boundary is bypassed.

The checked execution steps record local implementation/review, not PR creation,
merge, publication or deployment. Integration choice is pending; if a PR is
requested, its exact-head review window and hosted checks are subsequent gates.
