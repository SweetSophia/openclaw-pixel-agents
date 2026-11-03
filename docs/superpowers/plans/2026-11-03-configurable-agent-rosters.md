# Configurable Agent Rosters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user previously chose **native** execution; preserve that choice and use superpowers:executing-plans after plan review.

**Goal:** Configure existing OpenClaw agent IDs and public display names through guided setup or an editable file, without source edits or rebuilding.

**Architecture:** One pure roster contract serves the native ESM configuration CLI and compiled CommonJS server. Startup builds the explicit registry, overlays ID-keyed preferences without discarding absent agents, and preserves that registry as the private-access allowlist. Layout persistence retains literal seat identities; only rendering derives the old seat alias.

**Tech Stack:** Existing Node built-ins, strict TypeScript, CommonJS server, native ESM CLI, React/canvas, Vitest, Express/Socket.IO and current package/Docker tooling; no new dependency.

**Spec:** [Approved configurable-rosters design](../specs/2026-11-03-configurable-agent-rosters-design.md), committed as `74b945a`; user approved the complete design including the non-destructive legacy-seat resolution.

## Global Constraints

- Runtime: `^22.22.2 || ^24.15.0 || >=26.0.0`; no new dependencies or module-format migration.
- Optional dashboard-host `AGENT_ROSTER_PATH`: absolute path only; absent/empty uses defaults; whitespace-only, relative and `~` paths fail. Ambient environment keeps precedence over env files.
- JSON shape: `{ "version": 1, "agents": [{ "id": "main", "name": "Coordinator" }] }`; only those keys; 1–50 entries; maximum file size 64 KiB (65,536 bytes).
- IDs: exact/case-sensitive, 1–64 ASCII letters/digits/underscores/hyphens, first character a letter/digit; reject `__proto__`, `constructor`, `prototype` and duplicate IDs; never derive or normalize identities.
- Names: public trimmed nonempty Unicode text, at most 128 UTF-16 code units, no C0/C1 controls or Unicode line/paragraph separators; file validation rejects surrounding whitespace; wizard trims input before validation.
- Explicit invalid/missing/unreadable/nonregular/oversize configuration fails before listening, polling or Gateway startup; no silent default fallback, file repair or unsafe diagnostic echo.
- Explicit rosters replace defaults; existing IDs retain built-in default tags/recipes; new IDs start enabled with no tags and the safe existing appearance; saved preferences override by ID, never the configured name.
- Preserve validated absent-agent preferences and literal saved seats through removal/save/restart/re-addition. Legacy `shodan` lookup for `main` is temporary, exact `main` wins, and registered `shodan` forbids the alias.
- New bundles contain `agents.json`, `office.env` and remote-only `collector.env`; roster path belongs only in `office.env`. Keep preview/confirmation, exclusive creation, POSIX `0700`/`0600`, no-clobber, cleanup and retry guarantees.
- Keep `setup` read-only. No discovery commands, OpenClaw edits, services, network checks, credential rotation, public roster writes, hot reload, publication or deployment.
- Unknown ingest IDs stay rejected; configured registry remains the private task/workspace allowlist; existing session ownership, authentication, scope and transport checks remain intact.
- Keep coverage floors: branches 36, functions 37, lines 41, statements 39. Keep both audit gates and all existing CI/security gates.

## Review Focus

1. Valid ID `sub-worker` must remain an ordinary selectable agent, not be removed/faded or click-blocked by a `sub-` prefix heuristic — Task 3.
2. A disabled or other-room custom `shodan` must still suppress the legacy fallback; layout and full-roster arrival order must not matter — Task 3.
3. Valid inherited-property names such as `toString`/`valueOf` must get actual recipes, sprites and numeric palettes rather than object-prototype values — Tasks 2–3.
4. A bundle directory whose derived roster path cannot round-trip through dotenv must be retried at the directory prompt; destination retries retain roster answers and recompute the absolute path — Task 4.
5. Malformed UTF-8/JSON, control-bearing file contents and special files must produce bounded, sanitized startup failures, not raw parser excerpts or blocked reads — Tasks 1 and 5.

## File and interface map

- `shared/agentRoster.cjs` + `shared/agentRoster.d.cts`: pure version-1 schema, limits and fresh default ID/name lists; shared by both runtime module systems.
- `server/agentRoster.ts`: bounded regular-file loader, typed registry construction and built-in tag defaults; no HTTP or connection side effects.
- `server/index.ts`: wire roster/retained preferences before runtime startup; existing state/admission/control paths continue using the one registry.
- `server/agentPreferences.ts`: add explicit preference serialization that retains absent IDs; keep the current replacement/durability transaction.
- `shared/characterRecipes.ts`: own-key-safe recipe defaults.
- `src/game/seatIdentity.ts`: pure runtime-only seat lookup; `GameEngine.ts`, `PixelOffice.tsx` and `App.tsx` wire complete roster identity and real sub-agent classification.
- `server/validation.ts`: validate/copy literal seat keys; remove destructive alias rewriting only, not bounds/reserved-key protection.
- Existing three `bin/configure*.mjs` modules: roster questions, validated bundle/preview and fixed `agents.json` output allowance.
- `tsconfig.server.json`, `package.json`, `vitest.config.ts`, `scripts/smoke-package.mjs`: narrowly include the shared CommonJS runtime in compilation, packaging and coverage; qualify actual installed behavior.
- `agents.example.json`, `.env.example`, `.gitignore`, README, configuration/collector/contributor/agent notes: copyable contract and operational guidance, without pretending unreleased source is already published.

All paths below are relative to the linked worktree on `codex/configurable-rosters-20261103`, initially `74b945a` on merged main `0fab7ed`. Preserve the unrelated primary checkout and its dirty `.gitignore`.

Execution preflight, after this plan is reviewed: confirm the existing linked worktree/branch and clean tracked state, verify a supported `node --version`, fetch/read the current base without switching the primary checkout, then run `npm ci`, `npm run typecheck` and `npm test` as a fresh baseline. Investigate a failing baseline instead of attributing it to new work. Only the plan/spec are changed at this handoff.

### Task 1: Shared contract and bounded startup loader

**Files:** Create `shared/agentRoster.cjs`, `shared/agentRoster.d.cts`, `shared/agentRoster.test.ts`, `server/agentRoster.ts`, `server/agentRoster.test.ts`, `agents.example.json`. Modify `tsconfig.server.json`, `package.json`, `vitest.config.ts`, `scripts/smoke-package.mjs` (runtime-file allowlist assertions only).

**Interfaces:**
- Export types `AgentRosterEntry = { id: string; name: string }` and `AgentRosterDocument = { version: 1; agents: AgentRosterEntry[] }` from `.d.cts`.
- Export `AGENT_ROSTER_LIMITS = { maxAgents: 50, maxBytes: 65536, maxIdLength: 64, maxNameLength: 128 }`, `parseAgentId(value: unknown): string`, `parseAgentName(value: unknown): string`, `parseAgentRoster(value: unknown): AgentRosterDocument`, and `createDefaultAgentRoster(): AgentRosterDocument` from `.cjs` with matching declarations. Failures throw sanitized `Error` messages; parsed/default documents are fresh copies.
- Produce `loadAgentRoster(rosterPath: string | undefined): AgentRosterDocument` in `server/agentRoster.ts`. It consumes the shared contract and has no side effects except bounded file reads.

- [ ] **Step 1: Add parser and loader regressions.** Use Node test environments and temporary files. Preserve all eight default IDs/names/order from `defaultRegistry()`; default documents cannot share mutable entries. Assert both endpoints of every bound, duplicate exact IDs, permitted case distinction, unknown/reserved keys, null/arrays/wrong versions, name trimming/control rules, and acceptance of `toString`, `valueOf` and `sub-worker`.

```ts
expect(parseAgentId('sub-worker')).toBe('sub-worker');
expect(parseAgentName('研究 Assistant')).toBe('研究 Assistant');
expect(() => parseAgentId('_worker')).toThrow();
expect(() => parseAgentName(' Assistant ')).toThrow();
expect(createDefaultAgentRoster().agents.map(a => a.id)).toEqual([
  'main', 'miku', 'chi', 'sysauxilia', 'descartes', 'cyberlogis', 'cylena', 'cybera',
]);
expect(() => loadAgentRoster('relative.json')).toThrow(/absolute/i);
```

Test exactly 65,536 versus 65,537 bytes (including multibyte names), strict UTF-8 decoding, a valid UTF-8 BOM, escaped unpaired-surrogate names, malformed JSON with synthetic secret/control content, directory/missing path, and simulated permission/read failures at OS boundaries. Unicode names must remain well-formed, not become replacement characters during encoding. On POSIX, run a FIFO read in a bounded child fixture where `mkfifo` is available; it must exit promptly rather than require timeout termination. Assert files stay byte-identical after reads and diagnostics never contain the synthetic contents or unsafe path text.

- [ ] **Step 2: Run the new tests red.** `npm test -- shared/agentRoster.test.ts server/agentRoster.test.ts`. Expected initial failure: the contract/loader does not exist, not an unrelated fixture error.
- [ ] **Step 3: Implement the pure contract and `loadAgentRoster`.** Use explicit key allowlists and fresh output records; IDs are not lowercased and names are not silently trimmed by the parser. Keep only ID/name defaults in the shared runtime. Open explicit files without blocking on special-file opens where supported, verify the opened descriptor is regular, read at most `maxBytes + 1`, decode UTF-8 strictly, catch raw JSON/OS errors into safe diagnostics, and close in `finally`. Allow normal symlinks only when the opened target is a regular file. No raw file contents/path are interpolated into errors.
- [ ] **Step 4: Wire the minimal cross-module build.** Keep `.cjs` implementation and typed `.d.cts`, using statically named `exports.name` assignments for reliable native Node ESM import; server TS emits a normal `require`. Enable `allowJs` and explicitly include `shared/agentRoster.cjs` in the server tsconfig so the asset is emitted to `dist/server/shared/agentRoster.cjs`. Add only `shared/agentRoster.cjs`, `dist/server/shared/agentRoster.cjs` and `agents.example.json` to the npm allowlist; extend strict package-file checks for these exact additions. Add the one `.cjs` file to coverage inclusion without lowering floors. Docker already copies compiled `dist`; do not copy all source/shared files into its runtime.
- [ ] **Step 5: Verify green and actual module emission.** Run the two test files, `npm run typecheck`, `npm run build`, then `npm run test:package`. Expected: all pass; installed required-file checks find both the source CLI contract and compiled server contract. Verify their exported contract/default output agrees, rather than trusting filenames alone.
- [ ] **Step 6: Commit only this task's explicit files.** `git commit -m "feat: add validated runtime roster contract"` after staged diff/whitespace checks. No lockfile/dependency changes are expected.

### Task 2: Registry replacement, retained preferences and access boundaries

**Files:** Modify `server/agentRoster.ts`, `server/agentRoster.test.ts`, `server/index.ts:291-377`, `server/agentPreferences.ts`, `shared/characterRecipes.ts`. Create `server/agentRoster.http.test.ts`, `server/agentPreferences.test.ts`, `shared/characterRecipes.test.ts`. Extend `server/control/taskService.test.ts`, `server/control/workspaceService.test.ts` and existing persistence HTTP regressions as needed.

**Interfaces:**
- Consume Task 1's document/loader.
- Export `KnownAgent` from `server/agentRoster.ts`: `id`, `name`, required `pixelEnabled: boolean`, `tags: AgentTag[]`, `recipe: CharacterRecipe`, optional `characterSpriteId: string`.
- Produce `createAgentRegistry(roster: AgentRosterDocument, persisted: ReadonlyMap<string, PersistedPrefs>): Map<string, KnownAgent>`.
- Add `serializeAgentPreferences(registry: ReadonlyMap<string, PersistedPrefs>, retained: ReadonlyMap<string, PersistedPrefs>): string` to `server/agentPreferences.ts`; consumes validated preference maps, serializes only preference fields, current registry entries override retained entries.

- [ ] **Step 1: Add registry/serialization and HTTP tests.** Assert full replacement with `researcher`, unchanged defaults when unconfigured, built-in defaults retained for renamed `main`, safe new-agent recipe/tags/enabled defaults, cloned preference arrays/recipes, configured names authoritative, and no name/identity fields serialized into preferences.

```ts
const roster = parseAgentRoster({ version: 1, agents: [{ id: 'researcher', name: 'Research Assistant' }] });
const registry = createAgentRegistry(roster, new Map());
expect([...registry.keys()]).toEqual(['researcher']);
expect(registry.get('researcher')).toMatchObject({
  name: 'Research Assistant', pixelEnabled: true, tags: [],
  recipe: { bodyIndex: 0, hairIndex: 0, outfitIndex: 0 },
});
expect(getRecipe('toString')).toEqual({ bodyIndex: 0, hairIndex: 0, outfitIndex: 0 });
```

The HTTP fixture imports the actual server with isolated env/data and closes server/io/control resources after every import. Verify custom active/sleeping names via CLI polling (mock only child-process boundary) and ingest snapshots; unknown ingest IDs and unknown mutation targets remain denied. Perform save → edit roster/name → fresh server import → remove agent → save another agent → restart → re-add, checking the original appearance/tags/enabled preferences survive. Reject invalid persisted keys/values rather than retaining untrusted records.

For private controls, feed a registry-derived set to the real task/workspace services with synthetic Gateway boundaries: registered IDs still require correct ownership, unknown IDs cause no RPC, and a session key owned by a different agent is rejected. Invalid roster import must not call listener, poller, or Gateway connect; use boundary spies and a subsequent clean import to prove cleanup.

- [ ] **Step 2: Run focused tests red.** `npm test -- server/agentRoster.test.ts server/agentRoster.http.test.ts server/agentPreferences.test.ts shared/characterRecipes.test.ts`. Expected: missing registry/serializer and old registry semantics fail the intended assertions.
- [ ] **Step 3: Implement registry/serialization and wire startup.** Move `KnownAgent`/built-in tag policy out of the entrypoint. Load the configured document before constructing `AGENT_REGISTRY`; load/validate persisted records, then create the registry with deep copies. Keep the validated retained map for absent IDs; serialize its union with current registry state through the existing atomic helper and `onReplaced` boundary. Do not change route transaction, broadcast, durability-error or stale-snapshot behavior. Replace inherited recipe lookup with an own-key-safe lookup; apply the same rule to built-in tag metadata.
- [ ] **Step 4: Verify green with unchanged security/persistence paths.** Run the focused tests plus `npm test -- server/persistence.http.test.ts server/control/taskService.test.ts server/control/workspaceService.test.ts server/ingestSessions.test.ts`, then typecheck. Expected: no access widening and no loss after the full remove/save/restart/re-add cycle; names change only by file/restart, not preference routes.
- [ ] **Step 5: Commit the tested registry/persistence slice.** `git commit -m "feat: load configured rosters without losing agent preferences"` with explicit staging.

### Task 3: Literal seats and custom-ID-safe canvas lifecycle

**Files:** Create `src/game/seatIdentity.ts`, `src/game/seatIdentity.test.ts`, `src/components/PixelOffice.roster.integration.test.tsx`. Modify `server/validation.ts:137-155`, `server/validation.test.ts`, `server/layouts.http.test.ts`, `src/App.tsx`, `src/components/PixelOffice.tsx`, `src/game/GameEngine.ts`, `src/game/GameEngine.integration.test.ts`. Update fixtures in `src/components/PixelOffice.persistence.test.tsx`, `src/components/PixelOffice.preview.test.tsx`, `src/components/PixelOffice.rooms.integration.test.tsx`, `src/components/PixelOffice.subagents.test.tsx` and `src/hooks/useLayoutStore.test.tsx` for the real API/literal-seat contract.

**Interfaces:**
- Produce `resolveConfiguredSeats(seats: Readonly<Record<string, Point>>, registeredAgentIds: ReadonlySet<string>): Map<string, Point>` in `seatIdentity.ts`, using the existing exported `Point` from `src/game/Pathfinder.ts`; it returns a cloned **runtime** map, never modifies the layout.
- Add `GameEngine.setRegisteredAgentIds(ids: ReadonlySet<string>): void` and `GameEngine.isSubAgent(id: string): boolean`; these are real adapter APIs, not test seams.
- Add required `registeredAgentIds: readonly string[]` to `PixelOffice` props. `App` passes IDs from the full `agents` array, not `roomAgents` or an enabled-only filter. Existing room-filtered `agents` rendering is unchanged.

- [ ] **Step 1: Pin literal storage and pure fallback rules.** Replace only destructive-normalization expectations in server tests; keep reserved-key, coordinate, revision/concurrency and furniture-normalization assertions. An unrelated PUT and fresh server import retain both raw `main`/`shodan` keys. Freeze inputs in pure helper tests.

```ts
const seats = Object.freeze({ shodan: Object.freeze({ x: 9, y: 4 }) });
expect(resolveConfiguredSeats(seats, new Set(['main'])).get('main')).toEqual({ x: 9, y: 4 });
expect(resolveConfiguredSeats(seats, new Set(['main', 'shodan'])).has('main')).toBe(false);
expect(seats).toEqual({ shodan: { x: 9, y: 4 } });
```

Also assert exact `main` wins, true custom identities remain distinct, and the legacy fallback does not reserve the same coordinate twice under two runtime IDs. Remove custom `shodan`, save a layout through HTTP/store, restart and re-add: its literal seat must survive without a persisted synthetic `main` alias.

- [ ] **Step 2: Add real adapter/engine character regressions.** Extend existing real-engine fixtures, mocking browser boundaries only. Cover registered `shodan` in another room/disabled, full-roster-before-layout and layout-before-roster, legacy placement through rotated desk-floor resolution, obstacle rebuild/work-state returns, room changes and unchanged serialized layout seats. For `sub-worker`, verify repeated status sync does not fade/remove it and actual mouse/touch taps select it; true sub-agents still follow their lifecycle and remain nonselectable. Assert `toString`/`valueOf` get numeric palette values, usable portrait/sprite fallback and safe placeholder colors.
- [ ] **Step 3: Run the new helper/adapter tests red.** `npm test -- src/game/seatIdentity.test.ts src/components/PixelOffice.roster.integration.test.tsx`. Expected: missing helper/API and existing prefix/alias behavior fail. Record the relevant old server tests being intentionally replaced, not silently deleted.
- [ ] **Step 4: Implement literal validation and runtime-only identity.** Remove seat rekey/delete from server validation. In the helper, copy all literal reservations; only for the permitted alias replace `shodan` with `main` in the **returned runtime map**, avoiding duplicate reservations. Retain a separate deep copy of literal layout seats in `GameEngine`, derive configured seats on layout or full-membership changes, and reuse existing obstacle/reachable-floor machinery. Compare membership before invalidating so activity/name updates do not rebuild layout state. Never write derived seats into React layout state or saves.
- [ ] **Step 5: Wire full membership and semantic sub-agent checks.** Pass full IDs through `App`/`PixelOffice` before character sync, reapplying after asynchronous initialization when necessary. Use the actual character `isSubAgent` flag in mouse/touch selection and adapter cleanup; remove all four relevant `sub-` heuristics. Make palette and placeholder-color tables own-key-safe. Update existing component mocks with the new real APIs rather than weakening integration coverage or adding production-only test hooks.
- [ ] **Step 6: Verify the entire boundary.** Run helper/new adapter tests, `npm test -- server/validation.test.ts server/layouts.http.test.ts src/game/GameEngine.integration.test.ts src/components/PixelOffice src/hooks/useLayoutStore.test.tsx`, then typecheck. Expected: legacy visual position preserved; raw keys survive GET/PUT/autosave; room/disabled membership suppresses alias; normal and true sub-agent lifecycle tests pass.
- [ ] **Step 7: Commit this compatibility slice.** `git commit -m "fix: preserve roster seat identities and custom agent lifecycle"` with explicit files.

### Task 4: Guided roster generation and operator documentation

**Files:** Modify `bin/configure.mjs`, `bin/configure-values.mjs`, `bin/configure-files.mjs`, `bin/setup.mjs`, `bin/openclaw-pixel-agents.mjs` (help), `server/configureCommand.test.ts`, `server/configureValues.test.ts`, `server/configureFiles.test.ts`, `scripts/smoke-package.mjs` (existing prompt fixture), `.env.example`, `.gitignore`, `README.md`, `docs/configuration.md`, `collector/README.md`, `CONTRIBUTING.md`, `AGENTS.md`.

**Interfaces:**
- Consume Task 1's shared parser, per-field validators, limits and fresh defaults.
- Extend existing `buildConfiguration(answers, { home })`: optional `answers.roster: AgentRosterDocument`, defaulting to `createDefaultAgentRoster()`. Existing return shape `{ directory, files, preview, mode, privateAccess }` remains; `files` always includes serialized `agents.json` and `office.env` with `AGENT_ROSTER_PATH`.
- Keep `runConfigure({ ask, output, home })` and `writeConfigurationBundle({ directory, files })` signatures unchanged. Only add exact allowed filename `agents.json` to the writer.

- [ ] **Step 1: Add value/writer tests for the complete bundle.** Default/custom docs round-trip through the one parser; office dotenv path points to `<directory>/agents.json`; collector env has no roster path. Preview contains names/IDs but not secrets, and file count is two locally/three remotely. Inject write failure at each of the three positions, including a partial `agents.json`, proving owned-artifact-only cleanup and private permissions. Keep traversal/arbitrary filename rejection.

```ts
const plan = buildConfiguration({ directory, openclawBin: process.execPath, roster }, { home });
expect(parseEnv(plan.files['office.env']).AGENT_ROSTER_PATH).toBe(join(directory, 'agents.json'));
expect(parseAgentRoster(JSON.parse(plan.files['agents.json']))).toEqual(roster);
expect(Object.keys(plan.files).sort()).toEqual(['agents.json', 'office.env']);
```

- [ ] **Step 2: Add prompt-stage regressions.** Offer `Use the built-in agent roster? (yes/no)` with default yes, then custom `Number of agents` (default 1), `Agent N ID` and `Agent N display name` (default validated ID), after existing OpenClaw location settings and before optional private access. Test bounds, invalid/duplicate ID re-prompt, public-name/control validation, and no discovery/network/CLI calls. Cancellation/EOF at new prompts and preview creates no files. Use question-aware answers where positional fixtures become brittle.

At the destination prompt validate `dotenvValue(join(candidate, 'agents.json'))` before accepting a path. A quote-rich path that cannot be encoded must re-prompt there (not fail after collecting all answers); assert the exact stage and absence of a broken fallback. The earlier both-quote directory fixture could succeed because only its separately entered DATA_DIR needed dotenv encoding; replace that superseded success expectation with this earlier validation requirement, not a broad test deletion. A save-time destination race must retain all custom entries, recompute `AGENT_ROSTER_PATH`, retain explicit DATA_DIR provenance and require a fresh preview/confirmation. Preserve all existing secret redaction, parent checks, cancellation and no-clobber tests.

- [ ] **Step 3: Run the three configuration test files red.** `npm test -- server/configureValues.test.ts server/configureFiles.test.ts server/configureCommand.test.ts`. Expected: absent roster file/path/questions and writer rejection of `agents.json` fail the new contracts.
- [ ] **Step 4: Implement the wizard/bundle extensions.** Validate the optional document in `buildConfiguration`, serialize it with JSON and include its ID/name summary in the existing preview. Reuse shared validators at prompts; keep a stable in-memory roster across save retries. Explain existing identities, matching IDs, public names, manual editing and restart-to-apply. Keep setup/help read-only, token behavior unchanged and generated paths shell-safe. Update the package smoke's existing answer fixture for the new questions without removing its baseline checks.
- [ ] **Step 5: Update user/developer guidance with the working contract.** Replace README's source-edit/rebuild roster instruction with guided and manual file paths plus restart, complete replacement, default behavior, exact IDs, limits and an actionable invalid-config example. Add `AGENT_ROSTER_PATH` to `.env.example`; link the shipped `agents.example.json`. Explain tags/appearance remain office preferences, no automatic OpenClaw agent creation, and collector lists must include every submitted ID. Document absolute dashboard/container paths, read-only Docker mounts and ambient-env precedence. Keep feature availability tied to the source/upcoming release; do not claim a newly published version. Ignore runtime `agents.json` while keeping `agents.example.json` tracked; update relevant AGENTS/CONTRIBUTING checks only, not unrelated policy.
- [ ] **Step 6: Verify green and no documentation drift.** Run all three configuration test files, `npm run typecheck`, `npm run build`, `npm run test:package` and changed-doc local link/reference checks. Assert generated defaults/custom rosters both start through the existing loader, example parses, and runtime files are ignored while example/runtime code remain package-allowlisted. No real endpoints/credentials are used.
- [ ] **Step 7: Commit the onboarding slice.** `git commit -m "feat: configure agent IDs and names during guided setup"` with explicit source/test/doc staging.

### Task 5: Installed-consumer qualification and final review

**Files:** Extend `scripts/smoke-package.mjs` and `.github/workflows/ci.yml` (a separate custom-roster scenario in the existing Docker job, retaining its default-startup gate). Update `CONTRIBUTING.md`/`docs/configuration.md` for reproducible terminal/Docker checks and `docs/revamp-status.md` only with observed delivery evidence. Keep transient terminal/browser artifacts outside packaged/committed source.

**Interfaces:** Consume the completed source and actual packed installation. Produce a verification record keyed to the exact commit, distinguishing tests, installed artifact, synthetic browser/container acceptance, PR review and any unperformed deployment/publication.

- [ ] **Step 1: Extend the installed smoke's real scenarios.** Generate a custom two-agent roster (`main`, `researcher`) from the installed `runConfigure`, retain existing assets/key/no-side-effect/install-hook assertions, and start from the unrelated consumer cwd. Observe both API and `agents:update` on an actual Socket.IO client; the client is already installed, so add no dependency. Close sockets/processes in `finally` with bounded timeouts.
- [ ] **Step 2: Prove configuration-only restarts.** Change only `agents.json` to rename `researcher`, restart the same installed files, ingest again and assert the new name and unchanged saved recipe. Remove it, save another agent, restart/re-add and assert preferences persist. Test malformed/oversize/missing custom file exits nonzero before listener/readiness and does not print its synthetic contents. Test ambient roster path overriding an env-file value, with no accidental fallback to a consumer-cwd file. Run `npm run build` then `npm run test:package`; require all positive and negative scenarios to pass without a rebuild between roster edits.
- [ ] **Step 3: Exercise real terminals against source and the installed tarball.** In disposable private homes, run local/default, local/custom and remote/custom flows; retry duplicate IDs and a destination collision; exercise default-no, EOF and Ctrl+C. Inspect permissions and redacted preview before files appear. Use only synthetic endpoints/executables; the wizard must execute/contact nothing. Record exactly which OS/terminal was exercised rather than claiming native Windows qualification from Linux fixtures.
- [ ] **Step 4: Exercise a synthetic production browser.** Use a dedicated ephemeral server/data/roster fixture, not the live office. Verify a custom agent's portrait, canvas selection, details, appearance save and restart name update; include a `sub-worker` identity, Unicode/HTML-looking names rendered literally, room changes and legacy/custom seats. Inspect console/network errors. Check narrow and desktop widths for newly long names. No real Gateway credentials/tasks; no claim that this proves large-roster performance or live Gateway compatibility.
- [ ] **Step 5: Qualify Docker with a read-only mounted custom roster.** Extend the existing CI Docker job with this separate synthetic scenario, preserving its default-startup gate and existing permissions/action pins. Build the actual image; start an isolated named container with synthetic ingest credentials, `AGENT_ROSTER_PATH` pointing to a readable container-path file and a disposable data mount. Verify `/api/status`, SPA/assets, ingest/custom names and a container restart after editing only the host roster. A separately started invalid-file container must exit unsuccessfully. Use bounded retries and cleanup only exact fixture containers/directories; preserve script-free production installation. Run the same scenario locally when Docker is available; otherwise report the missing local evidence and require this matching container check in CI before merge readiness.
- [ ] **Step 6: Run the unchanged full gate from the isolated branch.** `npm ci`, `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate`, then `git diff --check`. Require explicit exit success, all four existing coverage floors, no unassessed audit failures and actual runtime asset inclusion. Tests/new fixture helpers must not hide failures with broad catches or weakened assertions.
- [ ] **Step 7: Commit smoke/docs changes and obtain the native workflow's fresh whole-branch review.** Verify the staged diff, commit with `test: qualify configurable rosters in installed consumers`, and give a fresh reviewer the approved spec, this plan, full base/head diff and evidence. Assess correctness, compatibility, security/ownership, bounded I/O, module packaging, state retention and real browser behavior; verify valid findings before fixing. Re-run affected checks after changes and the final gate in proportion to risk.
- [ ] **Step 8: Hand off the reviewed branch/PR with evidence.** Before the first GitHub write, require `gh api user --jq .login` to return exactly `SweetSophia`; prefer local `gh`. Preserve protections, evaluate actual bot comments and record the exact pushed revision and full 15-minute review window reset by each push. Pending checks/bots are not approval. Do not merge, publish, deploy, change real credentials/state or expand scope without the applicable user authorization; if subsequently merged, verify exact-head main CI/CodeQL separately.

## Plan self-review

- Contract, bounds, diagnostics and module distribution: Task 1. Startup/defaults/replacement, public/private identity and retained preferences: Task 2. Literal seats, full-roster aliasing, safe custom-ID rendering and existing layout concurrency: Task 3. Guided/manual onboarding, no-clobber and operator docs: Task 4. Real installed restart/negative cases, terminals/browser/Docker and full gates/review: Task 5.
- The five Review Focus conditions each have named assertions in the owning task; no configuration-only behavior is inferred from typecheck or a source import alone.
- Interfaces use the same `AgentRosterDocument`, `createAgentRegistry`, `serializeAgentPreferences`, `resolveConfiguredSeats`, `setRegisteredAgentIds` and `isSubAgent` names throughout. Existing public JSON schemas change only by retaining literal seat keys; no private task payload moves to the public store/socket.
- Native execution is preserved. Product implementation has not begun; review this plan before invoking superpowers:executing-plans.
