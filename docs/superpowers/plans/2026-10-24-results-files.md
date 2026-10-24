# Task Results and Delivered Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let an unlocked office user read the selected task's result and explicitly preview or download files shared by its assistant.

**Architecture:** Add a Results tab to the existing agent panel and use its existing selection, access provider and polling owner. A private artifact service consumes TaskService's canonical task facts and the existing paired Gateway connection; it never discovers host paths or fetches arbitrary external URLs. Artifact support is optional, preserving ordinary task and conversation access on older Gateways.

**Tech Stack:** Existing TypeScript, React, Express, native fetch/WebSocket/crypto, Vitest and Supertest; no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-24-results-files-design.md` (user-approved). Portable access-key onboarding in PR #299 is the prerequisite release.

## Global Constraints

- Use the repository Node range `^22.22.2 || ^24.15.0 || >=26.0.0`; run `npm ci` against the committed lock.
- Selected scope: assistant-delivered outputs, not a workspace browser. Never send a real task to manufacture verification data.
- Reuse the office key and paired `operator.read` device; do not add authentication modes, Gateway configuration, broader scopes, public socket fields or dependencies.
- Send `messageRole: "assistant"` and canonical agent/session/run filters on every artifact RPC; never retry with filters removed.
- Existing metadata cap 256 KiB; at most 100 summaries, newest available source sequence with stable ties and an explicit shortened-list notice.
- Text preview 256 KiB, UTF-8 only; transfer 16 MiB actual bytes; raster PNG/JPEG/WebP at most 8 MiB and 16 million pixels before decoding.
- Content budget: two concurrent transfers and six requests/minute per client IP, separate from send and metadata budgets; 30-second total content deadline.
- Artifact metadata: 32 selections, 60-second expiry, at most two seconds of successful reuse; visible refresh every five seconds through the existing hook.
- Keep the existing 2 MiB Gateway frame limit; HTTP route failure permits one filtered inline fallback, never a larger frame budget.
- Render text as text; HTML, SVG, PDF, archives, executables, audio and video are download-only. External links require explicit action, show their host and have no opener/referrer.
- Preserve current access key, device/grant, preferences/layouts, collector, preview services and shipped modal/canvas recovery. No private content, tickets or keys in logs, persistence, public events or URLs.

## Review Focus

1. A new run starts while an older file is transferring: no old bytes or preview may enter the new selection (Tasks 2, 3 and 6).
2. A file is JSON while the endpoint also returns JSON link descriptors/errors: file bytes must never be mistaken for control metadata (Tasks 4 and 5).
3. A phone uses direct-IP HTTP with no Clipboard API: the result stays selectable and offers manual-copy guidance (Task 6).
4. A Gateway has a non-root WebSocket endpoint or returns an expired/redirecting download grant: no origin/path broadening, credential forwarding or silent scope fallback (Tasks 1 and 3).
5. A declared small image is huge or malformed, or a filename includes header controls: bounds and safe rendering/headers hold before browser decoding (Tasks 3 and 4).

## File Ownership

- `shared/controlResults.ts`: normalized Results/file types, bounds and runtime parsers; imports existing shared control types.
- `server/control/artifactService.ts`: assistant-only discovery, scope fences, bounded metadata cache and invalidation.
- `server/control/artifactTransfer.ts`: native download resolution, same-Gateway HTTP policy, bounded byte reading and safe content outcome.
- `server/control/previewPolicy.ts`: MIME eligibility, UTF-8 preview truncation, raster signatures/dimensions and safe filenames.
- `server/control/contentBudget.ts`: content-only concurrency/rate admission and cleanup.
- Existing Gateway, TaskService, router and access owners gain the smallest required extensions; do not create a second authentication, task-discovery or modal owner.
- `src/control/useResultContent.ts`: explicit content actions and cancellation/Blob ownership only; metadata stays in `useTaskDetails`.
- `src/components/TaskResults.tsx` and `.css`: result text, scoped file list, preview and authored states inside TaskDetailsView.

### Task 1: Validated Results contract and optional Gateway reads

**Files:** Create `shared/controlResults.ts`, `shared/controlResults.test.ts`; modify `shared/control.ts`, `server/control/gatewayClient.ts`, `server/control/gatewayClient.test.ts`.

**Interfaces:**
- Consumes: `ControlTarget`, `ControlTaskSnapshot`, `ControlSource`, `ControlMessage`, `ControlRunState`, existing shared parsers and `ControlGateway.request`.
- Produces: `ControlArtifactScope = { kind: 'run'; runId: string } | { kind: 'conversation' }`.
- Produces: `ControlArtifactSummary` with bounded `id`, `type`, `title`, optional `mimeType`, `sizeBytes`, `runId`, `messageSeq`, and `download: 'bytes' | 'link' | 'unavailable'`; never raw image URLs/tickets.
- Produces: `ControlResultsSnapshot { target: ControlTarget; scope: ControlArtifactScope; source: ControlSource; runState: ControlRunState; responseKind: 'result' | 'latest' | 'none'; response?: ControlMessage; artifactState: 'ready' | 'unsupported' | 'unavailable'; artifacts: ControlArtifactSummary[]; artifactsTruncated: boolean }`. Project response fields from the verified TaskService snapshot without duplicating its activity/children/request payload.
- Produces: `ControlFileRequest { target: ControlTarget; scope: ControlArtifactScope; artifactId: string; intent: 'preview' | 'download' }`, `ControlExternalFile { kind: 'external'; url: string; host: string; title: string }` and exact parsers `parseControlResultsSnapshot(value: unknown): ControlResultsSnapshot | null`, `parseControlFileRequest(value: unknown): ControlFileRequest | null`, `parseControlExternalFile(value: unknown): ControlExternalFile | null`. Wire body for `/results/file` is this nested shape; route agent must equal target agent.
- Produces: optional `ControlGateway.artifactConnection?(): { id: string; generation: number; gatewayUrl: string } | null`, kept server-side. Extend `ControlMethod` with `artifacts.list`, `artifacts.get`, `artifacts.download`; optional absence/filter rejection maps to `unsupported`, genuine scope rejection remains `scope-required`.
- Produces: `file-unavailable`, `file-too-large`, `preview-unsupported` in the shared error union and existing error-body parser.

- [x] Write `results_contract_rejects_oversized_or_mismatched_scope`: assert 101 summaries, negative/nonfinite sizes, unsafe/reserved keys, malformed target/scope and >256 KiB metadata fail; a missing size stays absent. Bound artifact IDs to 512 characters, titles to 512, MIME to 128 and type to 64; reject control characters in opaque fields.
- [x] Write `old_gateway_keeps_task_reads_without_artifacts` and `assistant_filter_rejection_is_optional`: assert the existing four required read methods still connect, an absent artifact method rejects `unsupported`, and no retry without the assistant filter occurs. Keep the 2 MiB frame guard.
  Concrete assertions: `expect(parseControlResultsSnapshot({ ...validResults, artifacts: Array(101).fill(validArtifact) })).toBeNull()`; `await expect(oldGateway.request('artifacts.list', assistantSelection)).rejects.toMatchObject({ code: 'unsupported' })`; `expect(oldGateway.status().canRead).toBe(true)`. Build the valid fixtures from the exact interfaces above.
- [x] Run `npm test -- shared/controlResults.test.ts server/control/gatewayClient.test.ts`; expect the new cases to fail because the contract/capability extension does not exist.
- [x] Implement the interfaces above. Validate all nested target/scope fields and response presence: result requires a response plus completed run state, latest requires a response, none forbids it. Service tests own canonical run association. Link descriptors accept only HTTP(S), no embedded credentials, URL at most 4096 characters and host derived from that URL.
- [x] Rerun the focused command; expect all new and existing cases to pass. Run `npm run typecheck`.
- [x] Commit: `feat: define private result and artifact contracts`.

### Task 2: Task-owned scope verification and assistant-only metadata

**Files:** Create `server/control/artifactService.ts`, `server/control/artifactService.test.ts`; modify `server/control/taskService.ts`, `server/control/taskService.test.ts`.

**Interfaces:**
- Consumes: Task 1 types, `tasks.verifyTarget(target, signal)`, `tasks.getTask(input, signal)`, Gateway events and optional artifact RPCs.
- Produces: extend `TaskService.getTask(input: ControlTaskRequest, signal?: AbortSignal, options?: { fresh?: boolean }): Promise<ControlTaskSnapshot>`; fresh reads bypass successful cache reuse and coalesce only with equivalent fresh reads.
- Produces: `createArtifactService(gateway: ControlGateway, tasks: TaskService): ArtifactService`; `read(target: ControlTarget, signal?: AbortSignal): Promise<ControlResultsSnapshot>`, `clear(): void`, `close(): void`. Task 3 adds content actions to this interface.

- [x] Write `discovery_keeps_assistant_and_exact_scope`: assert all discovery params include assistant role, agent and session; canonical run means run scope, missing run means explicitly conversation scope; request/result completion semantics come only from TaskService.
- [x] Write `new_run_reset_branch_or_revocation_discards_pending_metadata`: pause list resolution, change canonical run/session/lifecycle/branch or source generation, resolve late and assert no old cache/result is returned. Routine activity marks metadata dirty without starving every read; destructive/access events cancel it.
- [x] Write `bounded_stale_metadata_keeps_original_time`: assert 100 newest stable summaries, byte-budget trimming with notice, 32-entry cache, expiry at 60 seconds, reuse no longer than two seconds, cloned returns and same-scope stale recovery preserving the old timestamp. Unsupported discovery still returns usable task text, with no filter removal or filesystem fallback.
  Concrete assertions: `expect(snapshot.scope).toEqual({ kind: 'run', runId: 'run-1' })`; `expect(listParams).toMatchObject({ agentId: target.agentId, sessionKey: target.sessionKey, runId: 'run-1', messageRole: 'assistant' })`; `expect(stale.source.observedAt).toBe(first.source.observedAt)`; `await expect(pendingRead).rejects.toMatchObject({ code: 'session-changed' })`.
- [x] Run `npm test -- server/control/artifactService.test.ts server/control/taskService.test.ts`; expect failures for the new behavior.
- [x] Implement fresh TaskService reads and discovery. Before and after awaited artifact work, use TaskService to verify canonical target/current task and compare scope; force fresh task facts for the final scope check. Key caches by full target/lifecycle/branch/source generation plus scope. Coalesce shared in-flight metadata reads and release each aborting subscriber independently. Project the selected task's verified result/latest response into the Results response so the client need not fetch `/task` in parallel; do not duplicate unrelated task payload. Set responseKind from task.result, else task.latestResponse, else none.
- [x] Rerun the focused tests; expect pass, including existing TaskService regressions.
- [x] Commit: `feat: discover scoped assistant results and delivered files`.

### Task 3: Bounded native file transfer and inert preview policy

**Files:** Create `server/control/artifactTransfer.ts`, `server/control/artifactTransfer.test.ts`, `server/control/previewPolicy.ts`, `server/control/previewPolicy.test.ts`; complete `artifactService.ts` and its content tests.

**Interfaces:**
- Consumes: Task 1 optional connection information and Task 2 canonical scope verification; native installed OpenClaw public artifact schemas documented in the spec.
- Produces: `ArtifactContent = { kind: 'bytes'; data: Uint8Array; mimeType: string; filename: string; truncated: boolean } | ControlExternalFile` exported from `artifactTransfer.ts`; extend `ArtifactService` with `file(input: ControlFileRequest, signal?: AbortSignal): Promise<ArtifactContent>`.
- Produces: `downloadArtifact(gateway: ControlGateway, input: ControlFileRequest, signal: AbortSignal): Promise<ArtifactContent>`; get/download use the same assistant/agent/session/run filters as discovery, and validate returned artifact identity/provenance before bytes are exposed.
- Produces: `previewContent(data: Uint8Array, mimeType: string): { data: Uint8Array; mimeType: string; truncated: boolean }` and `safeArtifactFilename(title: string): string` from `previewPolicy.ts`; invalid/unavailable/too-large/unsupported outcomes use typed control errors, not raw upstream errors.

- [x] Write `native_inline_http_and_managed_media_transfer`: exercise base64, connection-bound grant and managed media paths; assert complete bytes, MIME, safe filename and unchanged filters on get/download. External references return a descriptor without any server fetch.
- [x] Write `grant_policy_rejects_changed_origin_credentials_redirect_or_escape`: cover non-root Gateway URL, noncanonical encoded paths, wrong connection ID, redirects, expired grant and connection loss. Derive HTTP(S) origin from the configured WS(S) endpoint; accept only `/api/artifacts/download/<current-connection>/<ticket>` or `/api/chat/media/outgoing/<canonical-encoded-selected-session>/<uuid-v4>/<full-or-thumbnail>` with the source-provided ticket. Validate raw route components before URL normalization; encode/decode the session component against the selected key rather than banning valid encoded session characters.
- [x] Write `bounded_actual_bytes_and_predecode_dimensions`: assert absent/false Content-Length cannot exceed 16 MiB; raster >8 MiB, >16,000,000 pixels or malformed PNG/JPEG/WebP fails before decode; UTF-8 preview caps at 256 KiB without splitting characters, invalid UTF-8 is unsupported; HTML/SVG/PDF never preview. Header controls and path separators cannot survive in a download filename.
- [x] Write `late_content_for_changed_run_never_escapes`: hold the transfer, switch task/run/branch/source/access and assert cancellation plus final canonical revalidation rejects old bytes.
  Concrete assertions: `expect(content.kind).toBe('bytes')`; `await expect(misdeclaredTransfer).rejects.toMatchObject({ code: 'file-too-large' })`; `expect(() => previewContent(hugeDimensionsPng, 'image/png')).toThrow()`; `expect(externalFetch).not.toHaveBeenCalled()`; `await expect(changedRunTransfer).rejects.toMatchObject({ code: 'session-changed' })`.
- [x] Run `npm test -- server/control/artifactTransfer.test.ts server/control/previewPolicy.test.ts server/control/artifactService.test.ts`; expect the new cases to fail.
- [x] Implement native HTTP grant resolution using the same live paired connection, `redirect: 'error'`, bounded streaming and a 30-second total signal. Never forward office/Gateway authentication to an external URL. On unsupported/failed HTTP routing, resolve once via filtered inline mode within the existing 2 MiB frame budget; reacquire expired grants rather than replaying them across generations. Enforce limits on actual decoded bytes and inspect raster headers before creating browser-decodable content. `ArtifactService.file` performs fresh pre/post canonical checks and requires the displayed scope to remain current.
- [x] Rerun the focused tests; expect pass. Confirm fixtures never read a caller-supplied host file and no real Gateway task is sent.
- [x] Commit: `feat: transfer delivered files through bounded private reads`.

### Task 4: Authenticated routes, independent content budget and runtime wiring

**Files:** Create `server/control/contentBudget.ts`, `server/control/contentBudget.test.ts`; modify `server/control/routes.ts`, `server/control/routes.test.ts`, `server/control/validation.ts`, `server/index.ts`, `server/headers.test.ts`.

**Interfaces:**
- Consumes: `ArtifactService.read/file`, existing `createControlAccess`, new request parser and typed errors.
- Produces: optional `artifacts?: ArtifactService` router dependency; POST `/agents/:id/results` accepts an exact validated ControlTarget, POST `/agents/:id/results/file` accepts the nested ControlFileRequest shape from Task 1.
- Produces: content-budget middleware with two concurrent admissions and six requests/minute per client IP; releases admission once on finish/close/abort/error. Reuse existing IP/proxy trust policy.
- Produces: success header `X-Pixel-Control-File: bytes` for binary, `X-Pixel-Control-File: link` for normalized link JSON, no discriminator on error JSON; `X-Pixel-Preview-Truncated: true` only for a shortened preview. All private responses remain no-store.

- [x] Write `private_results_routes_validate_and_abort`: assert locked/origin/transport guards, reserved/extra fields, route-agent mismatch, arbitrary URL/path rejection and request-disconnect cancellation.
- [x] Write `json_file_is_not_link_or_error_metadata`: assert application/json downloads have the bytes discriminator and safe attachment disposition; external descriptors are distinct and normalized. Map file-unavailable/too-large/preview-unsupported to 404/413/415 without exposing upstream details.
- [x] Write `content_budget_does_not_consume_send_budget`: assert the third concurrent and seventh per-minute content request returns 429, metadata/sends retain their own budgets, and aborted/failed requests release concurrent admission exactly once.
  Concrete assertions: `expect(locked.status).toBe(401)`; `expect(jsonFile.headers['x-pixel-control-file']).toBe('bytes')`; `expect(link.headers['x-pixel-control-file']).toBe('link')`; `expect(thirdConcurrent.status).toBe(429)`; `expect(seventhInWindow.status).toBe(429)`; `expect(metadata.status).toBe(200)`.
- [x] Run `npm test -- server/control/routes.test.ts server/control/contentBudget.test.ts server/headers.test.ts`; expect new route/budget/CSP cases to fail.
- [x] Implement shared private error serialization for JSON/binary routes, explicit content response headers and service lifecycle wiring in `server/index.ts`. Keep the entrypoint to construction/mount/close calls. Add `blob:` only to CSP `img-src` for owned raster previews; preserve other security directives and add its assertion to the existing CSP test.
- [x] Rerun focused route/budget/CSP tests and `npm run typecheck`; expect pass.
- [x] Commit: `feat: serve private result metadata and bounded file content`.

### Task 5: Access-owned binary requests and content lifecycle

**Files:** Modify `src/control/api.ts`, `src/control/ControlAccess.tsx`, `src/control/ControlAccess.test.tsx`; create `src/control/api.test.ts`, `src/control/useResultContent.ts`, `src/control/useResultContent.test.tsx`.

**Interfaces:**
- Consumes: Task 4 route discriminator, typed link parser and existing access owner.
- Produces: `ControlFileResponse = { kind: 'bytes'; blob: Blob; filename: string; truncated: boolean } | ControlExternalFile` in `api.ts`; `controlFetchFile(path: string, key: string | undefined, init?: RequestInit): Promise<ControlFileResponse>`.
- Produces: `ControlAccess.requestFile(path: string, init?: RequestInit): Promise<ControlFileResponse>` with the same key/ref/revision/controller owner as JSON requests; the key is never exported to consumers.
- Produces: `ResultContentState` with `loadingId: string | null`, `error: ControlApiError | null`, `external: ControlExternalFile | null`, `preview: null | { artifactId: string; kind: 'text'; text: string; truncated: boolean } | { artifactId: string; kind: 'image'; url: string; mimeType: string }`, `act(artifactId: string, intent: 'preview' | 'download'): Promise<void>` and `clear(): void`.
- Produces: `useResultContent({ target, scope, active, current }: { target: ControlTarget | null; scope: ControlArtifactScope | null; active: boolean; current: boolean }): ResultContentState`.

- [x] Write `binary_json_and_errors_stay_distinct`: assert bounded streaming, required discriminator, no redirects, same-origin private route restriction, JSON byte files, typed external response and auth errors. Reject oversized/malformed content without keeping partial private bytes.
- [x] Write `lock_hidden_close_or_scope_change_reclaims_content`: assert all pending reads abort on generation/scope/activity/visibility changes, late bytes never win, every owned Blob URL is revoked, and no content enters browser persistence/public state. A user-exported download is allowed to remain saved.
  Concrete assertions: `expect(await jsonFile.blob.text()).toBe('{"ok":true}')`; `expect(pendingSignal.aborted).toBe(true)` after Lock; `expect(revokeObjectURL).toHaveBeenCalledWith(ownedUrl)` after scope change; `expect(result.current.preview).toBeNull()` after late resolution; `expect(localStorage.length).toBe(0)` for isolated private fixtures.
- [x] Run `npm test -- src/control/api.test.ts src/control/ControlAccess.test.tsx src/control/useResultContent.test.tsx`; expect failures for new APIs/lifecycle.
- [x] Implement the interfaces using existing access-owner cancellation and revision checks. Create raster Blob URLs only after validated content returns; text preview uses plain UTF-8 text. Download through an owned temporary anchor with safe filename and clean it up; external links remain explicit user actions with host displayed and no opener/referrer.
- [x] Rerun focused tests and typecheck; expect pass.
- [x] Commit: `feat: manage private file actions with access and selection lifecycle`.

### Task 6: Results tab with one selected-task refresh owner

**Files:** Create `src/components/TaskResults.tsx`, `src/components/TaskResults.css`, `src/components/TaskResults.test.tsx`, `src/components/AgentDetailPanel.test.tsx`; modify `src/control/useTaskDetails.ts`, `src/control/useTaskDetails.test.tsx`, `src/components/AgentDetailPanel.tsx`, `src/components/AgentDetailPanel.css`.

**Interfaces:**
- Consumes: Tasks 1/5 parsers/content hook, `TaskDetailsView` wrapper and existing conversation selector/focus owner.
- Produces: optional `resultsActive?: boolean` hook option and `results: ControlResultsSnapshot | null` state. When Results is active, the existing five-second read uses `/results` and updates `results`; it does not also call `/task` or start a second timer. Task continues using `/task` on its own active tab, and the server reuses TaskService for both projections. Existing callers keep their default behavior.
- Produces: `TaskResults({ state, active }: { state: TaskDetailsState; active: boolean })` inside TaskDetailsView; tabs are the single ordered array `task`, `conversation`, `results`, `agent`.

- [x] Write `results_share_selection_and_one_poll`: assert selecting/switching conversations preserves canonical selection across Task/Conversation/Results, Results polls once per five visible seconds, hidden/closed panels stop work, manual Refresh coalesces, and new task scope clears the old preview without moving focus unnecessarily.
- [x] Write `result_truth_and_authored_file_states`: assert only task.result receives the Result label; latestResponse says completion is unconfirmed; failed/running/unknown never become successful from file presence. Test no response, assistant-files empty, discovery unsupported, unavailable, stale original timestamp, shortened list, unknown size and no-longer-available file. Disable content actions while stale/unverified.
- [x] Write `copy_without_clipboard_keeps_selectable_text`: assert rejection/unavailability shows manual-copy guidance, plain text/line breaks remain selectable, and shortened-copy messaging describes the displayed text only.
- [x] Write `four_tabs_have_dynamic_keyboard_navigation`: assert Arrow/Home/End use array length, correct ARIA relationships, two-row narrow layout, 44px controls and existing dialog focus restoration. Existing canvas overlay regression must still pass.
  Concrete assertions: `expect(screen.getByRole('tab', { name: 'Results' })).toHaveAttribute('aria-selected', 'true')`; `expect(taskEndpointCalls).toHaveLength(0)` during Results polling; `expect(resultsEndpointCalls).toHaveLength(1)` per coalesced tick; `expect(screen.getByText(/completion is not confirmed/i)).toBeVisible()` for latestResponse; `expect(screen.getByText(/copy.*manually/i)).toBeVisible()` after clipboard rejection.
- [x] Run `npm test -- src/control/useTaskDetails.test.tsx src/components/TaskResults.test.tsx src/components/AgentDetailPanel.test.tsx`; expect the new cases to fail.
- [x] Implement the interfaces, response/file sections and preview/error states. Preserve same-scope stale data and timestamps; clear sensitive preview state on access/source/selection invalidation. Keep one content scroll area and existing modal cleanup; no additional overlay system.
- [x] Rerun focused tests and `npm run typecheck`; expect pass.
- [x] Commit: `feat: add accessible task results and delivered files panel`.

### Task 7: Native contract proof, browser acceptance and release

**Files:** Create `server/control/artifactIntegration.test.ts`; update `docs/task-access-setup.md`, `README.md` and this plan's checked steps; keep sanitized manual evidence/helpers in ignored task-owned storage.

**Interfaces:**
- Consumes: real Gateway adapter, artifact/task services, private HTTP router and client from Tasks 1–6; installed OpenClaw artifact protocol as the compatibility source.
- Produces: reproducible fixture integration and native transfer evidence, public feature/unsupported-version documentation, reviewed PR and preserved-state deployment.

- [ ] Write a controlled Gateway fixture test covering handshake/read scopes, assistant discovery, inline and connection-bound HTTP/managed transfer, external link, expiry, interruption and ownership races through real adapter/service/router paths. An oversized or mismatched native response must fail without widening permissions or falling back to host files.
- [ ] Run `npm test -- server/control/artifactIntegration.test.ts`; establish meaningful failing coverage before completing any uncovered adapter/route behavior, then rerun until pass. Record which fixture cases prove transfer rather than discovery only.
- [ ] Verify the installed Gateway's advertised methods and one successful native transfer using a permissible existing output or isolated synthetic Gateway/session. Keep private identifiers/URLs/content out of recorded public evidence; send no real agent task. If actual native transfer cannot be demonstrated, report that gate as unmet instead of claiming complete integration.
- [ ] Commit public documentation and sanitized evidence references: `docs: document result access and native transfer verification`. Keep private manual evidence in ignored storage; complete plan tracking without claiming unmet release gates.
- [ ] Run `npm run typecheck`, `npm run test:coverage`, `npm run build`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate` and `git diff --check`; require all to pass without lowering repository coverage/security gates.
- [ ] Browser-check desktop, phone and short windows: four tabs, keyboard/focus restoration, wrapping/44px targets, copy fallback on direct-IP HTTP, text/raster preview, inert download-only formats, external link host, slow transfer and switch/Lock/close/hidden-page cleanup. Use synthetic private fixtures; inspect screenshots and console/network errors. Verify existing portrait/overlay/canvas behavior.
- [ ] Obtain a fresh independent whole-branch review, fix valid findings and inspect every current-head inline bot thread/root review with pagination. Required CI must be green; the user's existing stalled-Kilo waiver applies. Verify local `gh api user --jq .login` is exactly SweetSophia before writes.
- [ ] Merge the reviewed exact head under standing authorization; back up current live data/config/device grant and previous runtime, deploy tested runtime only, and verify public roster plus existing private read/send capabilities without sending a task. Preserve current rotated grant rather than restoring an older staged credential. Stop only task-owned previews/browser sessions and record rollback location.
- [ ] Record actual merge, backup and live acceptance in the ignored release ledger; mark this plan complete only after the delivery gates actually pass.

## Self-Review and Execution Handoff

Spec coverage: Tasks 1–4 cover ownership/transport/bounds and optional native APIs; Tasks 5–6 cover content lifetime and the requested UI; Task 7 owns native proof, browser geometry and preserved-state release. Review Focus cases each have named owning tests. No workspace browser, uploads, historical run picker or real test messages are included.

Recommended execution: Native implementation by the current agent, then a fresh independent whole-branch review. These seven tasks share canonical scope and access contracts; keeping their implementation in one context avoids repeated reconstruction while preserving the required final independent gate. Review this plan before product implementation.
