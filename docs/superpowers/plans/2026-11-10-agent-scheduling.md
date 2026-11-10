# Native Agent Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let office users inspect, create disabled, edit, enable, and pause native schedules for a configured agent without widening ordinary task permissions.

**Architecture:** The ordinary private connection reads schedules; a separately paired, explicitly enabled device performs only closed scheduling RPCs. Strict ownership/projection and native revision checks guard edits. A durable metadata-only journal prevents unsafe create replay after uncertain outcomes.

**Tech Stack:** Existing TypeScript, React, Express, native WebSocket, Node filesystem/crypto, Vitest, Testing Library and Supertest; no new production dependency.

**Spec:** [Approved scheduling design](../specs/2026-11-10-agent-scheduling-design.md). Read it before executing any task.

## Global Constraints

- Management is opt-in: `CONTROL_SCHEDULES_MANAGE_ENABLED=false` by default; separate `DATA_DIR/control-schedules/` identity and `OPENCLAW_SCHEDULES_GATEWAY_TOKEN` / `OPENCLAW_SCHEDULES_GATEWAY_PASSWORD` bootstrap credentials.
- The scheduling management method list is exactly `cron.list`, `cron.get`, `cron.add`, and `cron.update`; ordinary task scopes never gain admin. Do not add Delete, Run Now, generic RPC, automatic pairing, or live tasks.
- New jobs: `sessionTarget: "isolated"`, `wakeMode: "now"`, `enabled: false`, `deleteAfterRun: false`, `payload: { kind: "agentTurn", message }`, `delivery: { mode: "none" }`, `failureAlert: false`, explicit selected agent/owner and server-generated declaration key.
- Bounds: name 128 characters; prompt 16 KiB UTF-8; interval one minute through 365 days; cron exactly five fields and at most 128 characters with explicit IANA timezone; job IDs/declaration keys 200 characters; opaque revisions 128 characters.
- Pagination: 50 native rows/request, 200 automatic, 2,000 cumulative per browse/recovery attempt; journal 500 retained records with no unresolved eviction.
- Native `expectedConfigRevision` is mandatory for edits/Enable/Pause. Declaration-key add is upsert, not exactly-once creation; no automatic mutation replay.
- Private files/directories are 0600/0700, with symlink refusal, atomic replacement, durability barriers and exclusive writer locking. Never persist prompts or credentials in the journal/logs/browser storage.
- Configured IDs remain literal/case-sensitive; unknown execution fields and unprovable ownership never become manageable. A schedule acknowledgement is not evidence of a run or task completion.
- Node `^22.22.2 || ^24.15.0 || >=26.0.0`; coverage floors branches 36, functions 37, lines 41, statements 39; retain both audit gates and existing CI protections.
- No implementation until this plan is reviewed and an execution method chosen. No live grants, deployment or publication follow from executing it.

## Review Focus

1. A page of maximum-size prompts exceeds the 256 KiB private response budget: continue from the unreturned native row, never truncate an editable prompt or silently lose jobs (Task 4).
2. A custom uppercase agent ID is valid in the roster but normalized by native cron: disable scheduling for it rather than scheduling under a different ID (Tasks 1, 5).
3. A crash leaves an exclusive journal lock and an ambiguous pre-send reservation: show read-only recovery metadata without stealing a live lock or replaying creation (Task 3).
4. An unrelated native caller edits a job between confirmation and dispatch: the native revision conflict preserves the user's draft and never silently rebases (Tasks 5, 6).
5. Generic private API error copy recommends retrying an uncertain send: scheduling needs its own no-replay copy, including after reload, hide/unmount or credential changes (Tasks 1, 6, 7).

## File map and existing seams

The planning baseline is main `27baa909151add9fe54782753d01f7a33233992e`; design commit `9b287e0` precedes its approval-status update. The owned worktree is on `codex/scheduling-design-20261110`. Preserve the unrelated `.gitignore` change in the primary checkout. Do not reuse the stale `feat/schedules` implementation.

| Area | Files and responsibility |
| --- | --- |
| Private contract | New `shared/controlSchedules.ts` and test: DTOs, bounds, closed request/response parsers. Extend `shared/control.ts` error vocabulary only; never public `shared/types.ts`. |
| Native projection | New `server/control/scheduleProjection.ts` and test: canonical IDs, ownership, safe native definition projection and fixed request construction. |
| Privileged transport | New `server/control/scheduleConfig.ts` and test; modify `server/control/gatewayClient.ts` (existing closed profiles, handshake and scoped reconnect) and tests. Existing `deviceIdentity.ts` remains shared private storage, not shared identity. |
| Recovery | New `server/control/scheduleJournal.ts` and test: exclusive durable creation metadata; no native calls. |
| Service/API | New `server/control/scheduleService.ts`, `scheduleMutations.ts`, `scheduleRoutes.ts` and corresponding tests. Modify `server/control/routes.ts:26-31` to mount behind office access; `server/index.ts:1824-1840` for wiring/disposal. |
| Client | New `src/control/useSchedules.ts` and test; extend private `src/control/api.ts`. New `src/components/AgentSchedules.tsx`, CSS and tests. Extend `AgentDetailPanel.tsx:44-70,115-150` and its tests. |
| Operator documentation | New `docs/schedules.md`; update `docs/configuration.md`, `.env.example`, `CONTRIBUTING.md` and `docs/revamp-status.md` only for shipped scheduling behavior/qualification. |

All locations above are baseline anchors, not durable line numbers. No graph index exists; do not create one as setup. Reuse existing access, `controlRecord`, byte sizing, read-deadline, modal-focus and private request helpers. Read current implementations before changing them; optional missing scheduling methods must not fail ordinary handshake.

## Task 1: Closed schedule contract and native projection

**Files:** Create `shared/controlSchedules.ts`, `shared/controlSchedules.test.ts`, `server/control/scheduleProjection.ts`, `server/control/scheduleProjection.test.ts`; modify `shared/control.ts:67-71`, `src/control/api.ts:6-38`, `src/control/api.test.ts`.

**Interfaces:** Produce these exported shared types and parsers; use strict plain-record/unknown-key checks and the existing 256 KiB response ceiling:

```ts
type ScheduleTiming = { kind: 'every'; everyMs: number } | { kind: 'cron'; expr: string; tz: string };
interface ScheduleDraft { name: string; message: string; schedule: ScheduleTiming }
type ScheduleIntent = { kind: 'create'; draft: ScheduleDraft }
  | { kind: 'edit'; jobId: string; revision: string; draft: ScheduleDraft }
  | { kind: 'enabled'; jobId: string; revision: string; enabled: boolean };
interface ScheduleConfirmation { operationId: string; agentId: string; intent: ScheduleIntent; expiresAt: number; epoch: string; currentEnabled: boolean | null }
interface ScheduleSubmit { operationId: string; intent: ScheduleIntent }
interface ScheduleRow { id: string; agentId: string; name: string; enabled: boolean; revision: string | null;
  scheduleKind: string; draft: ScheduleDraft | null; readOnlyReason: string | null; timingMetadata?: { anchorMs?: number; staggerMs?: number };
  nextRunAt?: number; lastRunAt?: number; lastRunStatus?: string }
interface ScheduleOperation { operationId: string; agentId: string; action: ScheduleIntent['kind'];
  state: 'confirmed' | 'observed' | 'changed' | 'unknown' | 'not-sent'; jobId?: string }
interface ScheduleManagement { configured: boolean; state: ControlGatewayState; canManage: boolean; epoch: string | null; reason: string | null }
interface ScheduleSnapshot { agentId: string; source: ControlSource; management: ScheduleManagement;
  jobs: ScheduleRow[]; operations: ScheduleOperation[]; scanned: number; truncated: boolean; nextCursor?: string }
```

Import `ControlGatewayState`/`ControlSource` from `shared/control.ts`. `parseScheduleDraft`, `parseScheduleIntent`, `parseScheduleConfirmation`, `parseScheduleSubmit`, `parseScheduleSnapshot`, and `parseScheduleOperation` each accept `unknown` and return their named type or `null`. Restrict `readOnlyReason` to `unsupported-definition`, `system-owned`, `revision-unavailable`, `bounds`, or null; `lastRunStatus` to `ok`, `error`, or `skipped`; management `reason` to `disabled`, `reader-unavailable`, `pairing-required`, `permission`, `unsupported`, `storage-unavailable`, `unavailable`, or null. `operationId` is server UUID, `epoch` an opaque bounded token, `expiresAt` a bounded timestamp, cursors at most 2,048 characters.

Projection exports `isCanonicalScheduleAgentId(id: string): boolean`, `projectScheduleJob(value: unknown, agentId: string): ScheduleRow | null`, `scheduleCreateDigest(agentId: string, draft: ScheduleDraft): string`, `buildScheduleCreate(agentId: string, declarationKey: string, draft: ScheduleDraft): Record<string, unknown>`, and `buildScheduleUpdate(intent: Exclude<ScheduleIntent, { kind: 'create' }>): Record<string, unknown>`. Digest a fixed-order canonical JSON projection with SHA-256; do not hash caller object property order. Native JSON is untrusted; no raw native fields in returned DTOs.

- [ ] **Step 1: Write failing parser/projection/error-copy tests.** Add named cases `rejects_multibyte_prompt_over_16384_bytes`, `accepts_60000_and_31536000000_interval_bounds`, `requires_five_fields_and_explicit_IANA_zone`, `omits_foreign_and_contradictory_owners`, `keeps_reserved_and_execution_override_jobs_readonly`, and `never_retargets_uppercase_roster_ids`. Assert `isCanonicalScheduleAgentId('Custom') === false`, `isCanonicalScheduleAgentId('custom-id') === true`, and never mutate roster IDs. Test 200/201-character IDs, 128/129-character revisions/names, lone surrogates, prototype keys, extra browser native fields, control characters, whitespace-only messages, absent next-run values and unsupported revisions. Assert create fields equal the Global Constraints and update payload contains only `{ message }` for prompt changes (plus `kind` only if the inspected native patch requires it); preserve other metadata. Add `schedule-outcome-unknown`, `schedule-changed`, `schedule-denied`, `schedule-storage-unavailable` codes; their copy never advises retrying a mutation and does not lock other panels.

  Assertion anchor for the named byte-boundary test:
  ```ts
  expect(parseScheduleDraft({ name: 'Daily', message: '😀'.repeat(4096), schedule: { kind: 'every', everyMs: 60000 } })).not.toBeNull();
  expect(parseScheduleDraft({ name: 'Daily', message: '😀'.repeat(4097), schedule: { kind: 'every', everyMs: 60000 } })).toBeNull();
  ```
- [ ] **Step 2: Run `npm test -- shared/controlSchedules.test.ts server/control/scheduleProjection.test.ts src/control/api.test.ts`.** Expect new tests to fail for missing exports or behavior, not unrelated environment errors. Before this first red run: inspect clean status/current main, supported Node, run `npm ci` and baseline `npm run typecheck` / `npm test`; record failures without weakening gates. Re-read the spec's native evidence and refresh fingerprints; inspect `agent-id-D1-Q6vR4.mjs` canonicalization (lowercase for valid IDs). Synthetic fixtures must match inspected schema, not import the installed package at test runtime.
- [ ] **Step 3: Implement the shared contract and pure projection interfaces.** Use `TextEncoder`, `Intl.DateTimeFormat` timezone validation and stdlib only. Require explicit matching `agentId`; owner/effective fields, if present, must agree; omit session/account ownership. Classify unknown execution-affecting fields conservatively. Closed compatible definitions allow only supported timing/payload/delivery/lifecycle fields; `deleteAfterRun: true` and absent/ambiguous effective delivery or alerts are read-only unless the native contract proves an equivalent safe default. Recognize finite nonnegative safe-integer native `anchorMs`/`staggerMs` as known timing metadata, not editable fields or unknown overrides: `jobs-CVzLYF9_.mjs:409-444` injects them during creation. Add `native_normalized_create_remains_manageable` for both interval and cron receipts; display native timing metadata and preserve native normalization on edits instead of stripping it. Native `service-DV6kx_EF.mjs:4400-4409` preserves unchanged interval anchors and reanchors changed intervals. Do not truncate prompts into compatibility. Follow the inspected native request/response shapes; do not infer newer scope support from online documentation.
- [ ] **Step 4: Run Step 2's test command and `npm run typecheck`.** Expect all targeted tests and both TypeScript checks to pass. Keep ordinary send/approval API copy unchanged.
- [ ] **Step 5: Commit the listed files as `feat: define private schedule contracts and native projection`.** Stage explicit paths only; save red/green evidence outside the patch.

## Task 2: Separate, lazy scheduling authority

**Files:** Create `server/control/scheduleConfig.ts`, `server/control/scheduleConfig.test.ts`, `server/control/scheduleGateway.test.ts`; modify `server/control/gatewayClient.ts:7-21,41-239` and `gatewayClient.test.ts`.

**Interfaces:** `loadScheduleConfig(env: NodeJS.ProcessEnv, dataDir: string, control: ControlConfig): ScheduleConfig` produces `{ enabled: boolean; url?: string; deviceDirectory: string; token?: string; password?: string }`. `ScheduleMethod = 'cron.list' | 'cron.get' | 'cron.add' | 'cron.update'`. Export `createScheduleGateway(config: ScheduleConfig): ScheduleGateway`; its interface is `start(): void`, `close(): void`, `status(): ScheduleManagement`, `connection(): { epoch: string; gatewayUrl: string; deviceId: string } | null`, and `request(method: ScheduleMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>`. Extend ordinary `ControlMethod` only with `cron.list`/`cron.get`; ordinary profile never permits add/update at runtime.

- [ ] **Step 1: Add signed-transport tests** using the real challenge/response frame fixture pattern in `gatewayClient.test.ts:23-71`. Cases `optout_has_no_files_or_socket`, `separate_devices_and_grants`, `management_only_requests_read_admin`, `ordinary_methods_unchanged_without_cron`, `cross_profile_RPC_is_rejected_before_send`, `device_only_reconnect_never_upgrades`, `revocation_invalidates_epoch`, and `native_revision_conflict_is_preserved`. Verify device signatures, distinct directories/tokens, default no-send/no-approvals capability on the scheduling connection, and all four negotiation methods before management becomes ready. Use runtime casts to attempt forbidden methods; a TypeScript union is not sufficient evidence.

  Assert against the captured scheduling connect frame:
  ```ts
  expect(connectFrame.params.scopes).toEqual(['operator.read', 'operator.admin']);
  expect(connectFrame.params.scopes).not.toContain('operator.write');
  ```
- [ ] **Step 2: Run `npm test -- server/control/scheduleConfig.test.ts server/control/scheduleGateway.test.ts server/control/gatewayClient.test.ts`.** Expect new-profile failures.
- [ ] **Step 3: Implement the two factories with shared internal signed transport mechanics and a closed profile discriminator.** Keep profile choice internal to server wiring, not browser input. Preserve ordinary scopes, model no-admin guard, optional reads and all existing error classifications. Scheduling uses its own bootstrap variables only and never requires ordinary session methods. Persist read/admin scopes only in the scheduling profile's own grant, and test a device-only restart with no bootstrap secret. Cached scheduling grants missing read/admin fail read-only; do not auto-upgrade/re-pair. Keep 8 pending requests, 5-second deadline, 2 MiB frame cap and existing reconnect backoff. Map native `CRON_JOB_CHANGED` specifically to `schedule-changed`; do not collapse all invalid requests into a conflict or claim all errors prove non-commit. Disconnected/timeout mutations remain ambiguous. `start()` is the sole lazy side-effect boundary; factory/config/status/close must not create an identity.
- [ ] **Step 4: Rerun Step 2 plus `npm run typecheck`.** Existing signed ordinary control/model tests must still pass. Assert no `cron.run`, `cron.remove`, workspace or chat call traverses management.
- [ ] **Step 5: Commit as `feat: isolate opt-in scheduling Gateway authority`.** Do not set real environment variables or pair a device.

## Task 3: Durable, metadata-only creation journal

**Files:** Create `server/control/scheduleJournal.ts`, `server/control/scheduleJournal.test.ts`.

**Interfaces:** Export `openScheduleJournal(options: { directory: string; binding: { gatewayUrl: string; deviceId: string } }): ScheduleJournal` and `readScheduleRecovery(directory: string, agentId: string): Promise<ScheduleReservation[]>`. The latter reads existing bounded metadata only: no creation, lock acquisition, identity allocation, network or writes. `ScheduleReservation` contains operationId, agentId, declarationKey, requestDigest, bindingDigest, createdAt, state (`uncertain`/`acknowledged`/`observed`/`changed`), optional native jobId; never draft/prompt/token. `ScheduleJournal` has `reserve(input: { operationId: string; agentId: string; requestDigest: string }): Promise<ScheduleReservation>`, `record(operationId: string, state: ScheduleReservation['state'], jobId?: string): Promise<void>`, `list(agentId: string): ScheduleReservation[]`, and `close(): Promise<void>`. Methods report typed `schedule-storage-unavailable`/`schedule-changed` failures. Allocate installation UUID once in the private journal; declaration key `pixel-agents:<installation UUID>:<operation UUID>` stays below 200 characters.

- [ ] **Step 1: Add filesystem tests in disposable `mkdtemp` directories.** `reservation_survives_restart_without_payload` asserts parsed disk JSON contains neither prompt nor token and duplicate ID/digest returns the same declaration. `digest_conflict_and_unresolved_duplicate_intent` rejects changed bodies and fresh IDs for the same unresolved agent/digest. `all_500_records_are_retained` refuses record 501 with no eviction. Test bad JSON/schema, missing/unsafe permissions, file/dir symlinks, simultaneous writers, stale locks, failed writes/rename/fsync and crash-shaped states. Reopen after graceful close; separately simulate an abandoned lock and assert read-only metadata is still inspectable but `reserve` and `record` cannot write. Never automatically remove an unverified lock.

  After 500 distinct reservations, assert (using a new UUID and digest):
  ```ts
  await expect(journal.reserve(nextReservation)).rejects.toMatchObject({ code: 'schedule-storage-unavailable' });
  expect(journal.list('main')).toHaveLength(500);
  ```
- [ ] **Step 2: Run `npm test -- server/control/scheduleJournal.test.ts`.** Expect missing module/behavior failures.
- [ ] **Step 3: Implement journal methods using Node filesystem/crypto.** Serialize mutations; reserve durable `uncertain` state **before any native send**. Same installation/agent/body uses canonical SHA-256 digest with endpoint/device binding; persist no body. Bound file input bytes and record counts. Use exclusive writer lock, private temp file, file fsync, atomic rename, directory fsync and cleanup of owned temporary files. A durability failure poisons further writes for the process; no RPC can proceed. Do not steal stale locks automatically: operator verification/maintenance is documented in Task 8. Read-only fallback never changes metadata. `close()` releases only this instance's owned lock after queued writes settle; idempotent close, no new reservation while closing.
- [ ] **Step 4: Rerun journal tests plus typecheck.** Assert crash-shaped reservations stay uncertain on reopen and a second process/instance cannot erase an active lock. Unsupported durability guarantees fail creation closed, not silently degrade to best effort.
- [ ] **Step 5: Commit as `feat: reserve schedule creates durably without replay`.** No journal data/lock files are committed.

## Task 4: Bounded private schedule browsing and lifecycle wiring

**Files:** Create `server/control/scheduleService.ts`, `scheduleService.test.ts`, `scheduleRoutes.ts`, `scheduleRoutes.test.ts`; modify `server/control/routes.ts:26-31`, `server/index.ts:1824-1840`.

**Interfaces:** `createScheduleService(options: { reader: ControlGateway; manager: ScheduleGateway; config: ScheduleConfig; registeredAgents: () => ReadonlySet<string> }): ScheduleService`. Service exports `read(agentId: string, cursor?: string, signal?: AbortSignal): Promise<ScheduleSnapshot>`, `operations(agentId: string): Promise<ScheduleOperation[]>`, and `close(): Promise<void>`; Task 5 extends it with mutations. New `createScheduleRouter(service: ScheduleService): Router`, mounted at `/agents/:id/schedules` **after** `createControlAccess`; use `Router({ mergeParams: true })` so the literal parent ID is retained. Read endpoints: `GET /` (optional opaque `cursor`) and `GET /operations` (safe metadata only, same agent authorization). `operations` uses Task 3's read-only recovery loader, projects away declaration/digest/binding internals, and never dispatches or pairs anything. Missing journal means no recovery records; corrupt journal means an explicit recovery error, not an empty list. Changed endpoint/device binding leaves a pending record unknown and prohibits reconciliation under the new identity.

- [ ] **Step 1: Write service/HTTP tests** `filters_owned_jobs_but_tracks_scanned_native_rows`, `large_prompts_continue_at_unreturned_row`, `malformed_page_does_not_claim_empty`, `uppercase_roster_disables_without_retargeting`, and `reader_outage_never_falls_back_to_admin`. Assert at most 50 native jobs/response, response JSON <=256 KiB, ASCII prompt not truncated, exact continuation after a byte-limited response, explicit partial results at 200/2,000 scanned rows, and no absence claim based on filtered/offset pages. Test wrong key, transport, Origin (through real app integration), unknown agent, cursor reuse across agents/epochs, unconfigured control, independent pairing state and private no-store responses. Closing the HTTP server without `startServer()` closes scheduling service and manager.

  For a native page containing 50 maximum-size prompts, assert:
  ```ts
  expect(controlByteSize(snapshot)).toBeLessThanOrEqual(256 * 1024);
  expect(snapshot.nextCursor).toEqual(expect.any(String));
  expect(snapshot.jobs.every(row => row.draft?.message.length === 16384)).toBe(true);
  ```
- [ ] **Step 2: Run `npm test -- server/control/scheduleService.test.ts server/control/scheduleRoutes.test.ts server/control/routes.test.ts`.** Expect the new API/lifecycle tests to fail.
- [ ] **Step 3: Implement reads, router mounting and wiring.** Use native `cron.list` with `includeDisabled: true`, `limit: 50`, bounded offset and explicit agent filter, then independently prove ownership. Validate the inspected native list/get envelope, pagination arithmetic and non-advancing offsets; never trust a filter as ownership. Server-owned opaque cursors bind exact agent, reader epoch, scanned count and offset, expire at 60 seconds, maximum 100 active cursors; restart/eviction reports refresh required, never starts a hidden scan. Stop before an unreturned row exceeds the byte budget and resume that row. Do not claim an offset list is a transactional snapshot: edits/inserts can require refresh. On first authenticated nonhistorical-independent schedule browse with opt-in, `manager.start()` may initiate the separately configured handshake; default opt-out has zero manager I/O. Display management status without exporting credentials/device tokens. Add server close handling before Gateway close and no global `listening` start for management. Keep ordinary controls wired to the ordinary Gateway only.

  Disposal synchronously stops new admissions and closes the manager connection, then awaits admitted work's conservative settlement and journal flush/owned-lock release. Observe async disposal rejection in the HTTP close handler with sanitized logging; never leave an unhandled promise. Tests await disposal completion before asserting lock cleanup.
- [ ] **Step 4: Rerun Step 2 plus `npm run typecheck`.** Exercise actual Express wiring and no-store/auth behavior, not only mocked handler calls. No task/session requirement may leak into agent-scoped scheduling.
- [ ] **Step 5: Commit as `feat: browse owned schedules through private bounded API`.** This slice is read-only even with management enabled.

## Task 5: Confirmed mutations, native CAS, and no-replay recovery

**Files:** Create `server/control/scheduleMutations.ts`, `scheduleMutations.test.ts`; extend `scheduleService.ts`, `scheduleService.test.ts`, `scheduleRoutes.ts`, `scheduleRoutes.test.ts`.

**Interfaces:** `createScheduleMutations(options: { manager: ScheduleGateway; journal: ScheduleJournal; registeredAgents: () => ReadonlySet<string>; readerReady: () => boolean }): ScheduleMutations` produces `prepare(agentId: string, intent: ScheduleIntent, signal?: AbortSignal): Promise<ScheduleConfirmation>`, `submit(agentId: string, input: ScheduleSubmit): Promise<ScheduleOperation>`, `reconcile(agentId: string, operationId: string, signal?: AbortSignal): Promise<ScheduleOperation>`, and `close(): Promise<void>`. `ScheduleService` delegates the same methods; open the journal lazily after manager readiness supplies a real device binding, never under a guessed identity. Add `POST /prepare` with exact `{ intent }`, `POST /submit` with `ScheduleSubmit`, and `POST /operations/:operationId/reconcile` with exact `{}`. HTTP disconnect cancels reads/preflight, **not** admitted mutation work or its recovery record.

- [ ] **Step 1: Add mutation tests** `create_is_disabled_and_reserved_before_send`, `duplicate_operation_never_adds_twice`, `new_operation_same_uncertain_digest_is_blocked`, `lost_add_reply_after_restart_is_reads_only`, `native_edit_race_returns_conflict_without_rebase`, `enabled_patch_never_reconstructs_job`, `changed_declaration_is_not_restored`, and `crash_before_send_is_conservatively_unknown`. Assert no add on journal reservation/fsync failure; zero mutation on expired confirmation, changed epoch/agent/body/registry membership/owner/permissions; one add on simultaneous identical submit; ambiguous create receipt or `created: false` demands inspection, not an assertion that a new job was created. Test metadata write failure after a successful native commit: remain unknown, never retry. Unresolved records at capacity must not block unrelated reads or ordinary controls. Verify canonical ID before **creation**, including when no schedules exist.

  For pause, assert the whole native request (not a subset):
  ```ts
  expect(updateParams).toEqual({ id: 'job-1', expectedConfigRevision: 'revision-1', patch: { enabled: false } });
  expect(nativeMethods.filter(method => method === 'cron.add')).toHaveLength(1);
  ```
- [ ] **Step 2: Run `npm test -- server/control/scheduleMutations.test.ts server/control/scheduleService.test.ts server/control/scheduleRoutes.test.ts`.** Expect the new mutation behavior to fail.
- [ ] **Step 3: Implement preparation/dispatch/recovery.** Use 60-second preparation tickets, at most 100 in memory, server UUID operation IDs and frozen canonical intents; bind agent, epoch/endpoint/device and current definition/revision. Expiration/eviction invalidates only unsent tickets. Mutation admission: four concurrent reads and one mutation per agent, at most four mutations globally, ten mutations/minute per office; deny before dispatch without changing an unresolved operation. Browser generation/draft fencing is Task 6, not a browser-asserted security credential. Resolve journal duplicate operation/intent before requiring a still-live preparation ticket; an existing reservation always returns status, never dispatches again.

  Create: verify reader+manager readiness, canonical registered ID and unchanged connection binding; reserve durably; send the fixed native add exactly once without an HTTP cancellation signal; parse both inspected add result envelopes and verify declaration/owner/disabled fields. Edit/Enable/Pause: management `cron.get` proves current compatible owner and exact reviewed revision, then pass that revision to native `cron.update` under its own lock. Connection changes between preflight/send are fenced locally; native CAS remains authoritative. Freeze admitted operation and keep bounded dedup metadata for updates without adding payloads to disk. No automatic retry after native or HTTP timeouts.

  Reconcile: look up the exact journal entry/binding, use bounded list/get reads, compare exact declaration and ownership. Expose `observed`/`changed` rather than reconstructing an unrecorded payload. Partial/not-found remains `unknown`; no force-reset/new-ID button. Journal status changes are durable when writable; failure leaves persistent uncertainty even if an observed job is shown temporarily. Use independent schedule-specific error codes and sanitized messages; generic send retry copy is forbidden here.
- [ ] **Step 4: Rerun Step 2 plus typecheck and ordinary `sendService`, `modelService`, `approvalService`, and `runControlService` tests.** Test synthetic transport+real journal+HTTP through restart/disconnect in at least one integration case, not just a mocked promise rejecting.
- [ ] **Step 5: Commit as `feat: manage schedules with native revisions and safe recovery`.** Do not invoke the live Gateway to qualify a mutation.

## Task 6: Private schedule hook and confirmation fencing

**Files:** Create `src/control/useSchedules.ts`, `src/control/useSchedules.test.tsx`; extend `src/control/api.ts` and `api.test.ts` only as needed by Task 1's schedule errors.

**Interfaces:** `useSchedules(options: { agentId: string; active: boolean; historical: boolean })` returns `{ snapshot: ScheduleSnapshot | null; draft: ScheduleDraft | null; confirmation: ScheduleConfirmation | null; loading: boolean; stale: boolean; error: ControlApiError | null; operation: ScheduleOperation | null; setDraft(draft: ScheduleDraft | null): void; refresh(): Promise<void>; loadMore(): Promise<void>; prepare(intent: ScheduleIntent): Promise<void>; submit(): Promise<void>; reconcile(operationId: string): Promise<void> }`. Use existing `useControlAccess().request`/generation and `controlReadDeadline`; no new credential store.

- [ ] **Step 1: Add hook tests** `reads_without_conversation_target`, `invalidates_confirmation_on_draft_agent_generation_epoch_or_history_change`, `clears_private_payload_on_lock`, `late_hidden_response_cannot_restore_data`, `preserves_draft_on_revision_conflict`, `unknown_submit_never_replays_on_remount`, and `recovery_after_reload_has_no_saved_prompt`. Assert hidden/unmounted reads abort; submit is disabled if historical/stale/unlocked checks fail; multiple clicks send one operation ID; response schema/agent mismatch is dropped; refreshing data can invalidate old confirmation but does not discard a conflict draft. Automatic loading stops at 200 native scanned rows, explicit more at 2,000, and polling never restarts a mutation.

  After locking and resolving a deliberately delayed read, assert:
  ```ts
  expect(result.current.snapshot).toBeNull();
  expect(result.current.draft).toBeNull();
  expect(result.current.confirmation).toBeNull();
  ```
- [ ] **Step 2: Run `npm test -- src/control/useSchedules.test.tsx src/control/api.test.ts`.** Expect missing hook/fencing failures.
- [ ] **Step 3: Implement the hook as a bounded state machine.** Confirmations bind access generation, exact agent, draft generation, native job/revision, management epoch and monotonic local expiry (do not trust browser/server clock agreement). Recheck all bindings synchronously before submission. A hidden tab stops reads and invalidates confirmation; clear private payload on lock/generation/agent change. Keep draft through ordinary transient errors or leaving/reentering an already mounted tab, never through credential lock. Schedule reads refresh at most every 15 seconds while visible/unlocked/active, with no overlap; stop automatic refresh during dirty edits/confirmation/admitted mutations, mark stale as needed and require explicit fresh preparation. No polling of an uncertain mutation: user-triggered read-only reconcile only. Request aborts or malformed/lost mutation replies become no-replay uncertainty, not generic retry instructions. Never store prompts in module-global guards, URLs or browser storage.
- [ ] **Step 4: Rerun Step 2 plus `npm run typecheck`.** Use fake timers and delayed replies to prove effects do not restart reads/mutations unexpectedly. Existing private lock semantics must remain intact.
- [ ] **Step 5: Commit as `feat: add private schedule state and confirmation lifecycle`.**

## Task 7: Accessible agent-scoped Schedules panel

**Files:** Create `src/components/AgentSchedules.tsx`, `AgentSchedules.css`, `AgentSchedules.test.tsx`, `AgentSchedules.integration.test.tsx`; modify `AgentDetailPanel.tsx:44-70,115-150`, `AgentDetailPanel.css`, `AgentDetailPanel.test.tsx`, `AgentDetailPanel.history.test.tsx`.

**Interfaces:** `AgentSchedules({ agentId, active, historical, onReturnToLive }: { agentId: string; active: boolean; historical: boolean; onReturnToLive: () => void }): React.JSX.Element` consumes Task 6's hook. Keep it mounted behind the existing tab's `hidden` boundary so tab-local draft retention is deliberate; hook `active` controls reads. It must not use `TaskDetailsView`'s conversation-selection gate. Use `historical` from `runSelection?.agentId === agent.id`, not only a currently resolved `selectedRunId`, so a transient history read cannot unlock mutations.

- [ ] **Step 1: Write component/integration tests** `can_open_schedules_for_agent_without_sessions`, `history_is_current_schedules_readonly_until_return_live`, `creates_disabled_then_enables_only_after_second_confirmation`, `enabled_edit_warns_future_runs_change`, `unsupported_rows_never_show_raw_payload`, `unknown_operation_has_reconcile_not_retry`, and `tab_navigation_preserves_conversation_draft`. Assert accessible names, arrow/Home/End tabs, labels, focus after cancel/close, paired/unpaired/disabled/stale/loading/empty/limited views, no Delete/Run Now, no generated next-run time, and no mutation merely on mount/tab switch/Escape. Enable copy says ordinary tools can act externally despite no announcements; pause copy says existing runs may continue; result says acknowledged/observed rather than completed task.

  In the uncertain-operation view, assert:
  ```ts
  expect(screen.getByRole('button', { name: 'Reconcile' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: /retry|run now|delete/i })).not.toBeInTheDocument();
  ```
- [ ] **Step 2: Run `npm test -- src/components/AgentSchedules.test.tsx src/components/AgentSchedules.integration.test.tsx src/components/AgentDetailPanel.test.tsx src/components/AgentDetailPanel.history.test.tsx`.** Expect new-tab/form assertions to fail.
- [ ] **Step 3: Implement panel and tab integration.** Provide interval and five-field cron/IANA timezone forms, exact-target review, distinct management/read status, partial-source warnings, and recovery metadata. Show known native anchor/stagger facts before enabling; explain native default staggering and changed-interval reanchoring when editing timing, without inventing a next-run timestamp or adding override controls. Display local field errors before prepare without weakening server validation. Buttons/inputs have at least 44px touch targets, wrapped long text, status announcements, existing drawer scrolling and focus containment. The historical banner includes an explicit return-to-live action. No canvas/roster/layout persistence changes.
- [ ] **Step 4: Rerun Step 2, Task 6 tests and typecheck.** Add a real provider/private API synthetic integration path, not exclusively a mocked hook, to prove disabled-first and lock clearing across component boundaries.
- [ ] **Step 5: Commit as `feat: expose accessible native schedules in agent details`.**

## Task 8: Operator docs and whole-delivery qualification

**Files:** Create `docs/schedules.md`; modify `docs/configuration.md`, `.env.example`, `CONTRIBUTING.md`, `docs/revamp-status.md`. Add `server/control/scheduleIntegration.test.ts` for whole-stack protocol/restart cases not already covered; keep browser evidence synthetic and outside committed fixtures unless intentionally reusable.

**Interfaces:** No new runtime interface. Operator documentation consumes actual config/error/UI contracts from Tasks 1–7. Qualification report records exact source SHA, commands, results, independent review findings and limits; it never treats local source as published/live.

- [ ] **Step 1: Add a whole-stack regression test** `dropped_create_reply_then_native_edit_and_restart_never_upserts_again`: signed fake Gateway accepts a disabled create, drops its reply, a second actor changes that job, office restarts using the same disposable private directory, user reconciles, and total `cron.add` calls remains one while current changed job is not overwritten. Add actual server-close cleanup and default-off packaged startup checks if existing gates do not cover them. Run `npm test -- server/control/scheduleIntegration.test.ts`; if it exposes a gap, record red before the necessary behavior fix. If already green, record it as qualification evidence, not a demonstrated red/green regression. Use Tasks 2–7 interfaces, not production-only test seams.

  Across both office instances, assert:
  ```ts
  expect(frames.filter(frame => frame.method === 'cron.add')).toHaveLength(1);
  expect(nativeJob.payload.message).toBe('Changed by another operator');
  expect(recovery.state).not.toBe('confirmed');
  ```
- [ ] **Step 2: Make only the fixes required by that evidence, then rerun the integration test.** Expect all cases pass. Documentation explains independent admin grant risk/revocation, temporary bootstrap removal, unsupported native contracts, disabled-first creation, interval/DST semantics, pause limitations, recovery and journal maintenance. For a full/abandoned journal, instruct stopping/verifying all office writers, preserving a private backup, inspecting native declarations and resolving with the operator; do not recommend deleting uncertain records or resetting the journal to retry. A stale lock may be removed manually only after all writers are verified stopped. No config wizard grant changes are in scope. Document default-off behavior in `.env.example`; link configuration to the new guide, with source-versus-release availability.
- [ ] **Step 3: Run the full local gate** on the exact final source: `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high`, and `npm audit --audit-level=moderate`. Expect exit 0 throughout and all four coverage floors met; record test counts rather than inventing a baseline. Run `git diff --check`. Execute the existing synthetic Docker build/startup/roster smoke from `CONTRIBUTING.md`, with management disabled and no host credentials/data volumes. No new production dependency or install hook is justified by this plan.
- [ ] **Step 4: Run real-browser qualification against a disposable synthetic Gateway and production build.** Use browser-testing skill before this step. Check 320/390/768/1024/1440px widths and short landscape; arrow/Home/End, Enter/Space, focus containment/return, 44px targets, one vertical scrolling area, long prompts, zoomed text, confirmation keyboard flow, interval/cron zones, pair-required and partial/unknown recovery states. Inspect console/network and browser storage; verify no private/public socket leak. Test switch agent/history/lock/hide during delayed reads and admitted mutations. No live pairing or actual tasks. Record observed results/screenshots with synthetic text only; jsdom passing is not geometry evidence.
- [ ] **Step 5: Commit docs and qualification fixes as `docs: document isolated scheduling setup and recovery`.** Before claiming merge readiness, request independent whole-branch correctness/security review with exact SHA and spec; adjudicate any findings with reproductions, fix valid issues test-first, rerun affected/full gates, and check CI/CodeQL/dependency review/bot threads at the new head. Respect repo review windows/protections; no bypass/force-push. Publish a Ready PR only through authenticated `gh` after `gh api user --jq .login` returns exactly `SweetSophia`. Do not infer authorization for live grants, deployment, npm publication or unrelated dependency updates.

## Self-review and execution handoff

Coverage mapping: authority/config/lifecycle → Tasks 2/4; ownership/closed inputs → Task 1; disabled-first/CAS → Task 5; durability/no replay → Tasks 3/5/8; private REST/bounds → Tasks 1/4; tab/generation/history/accessibility → Tasks 6/7/8; documentation/source-release distinction and repository gates → Task 8. The five Review Focus cases each have a named owning regression above. No design requirement is intentionally deferred except the explicit non-goals.

Before implementation, the human reviews this plan and chooses **subagent-driven** (fresh implementer/reviewer per task, plus whole-branch review) or **native** (one implementer, then fresh whole-branch review). Recommended: subagent-driven, because privilege isolation, filesystem durability and mutation recovery are separately reviewable high-risk boundaries. Either method uses the same tests and acceptance gates. Do not start a second implementation worktree or mutate product code while waiting for this choice.
