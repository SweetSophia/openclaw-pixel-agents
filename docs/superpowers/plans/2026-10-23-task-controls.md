# Task Details and Conversation Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** First ship source-backed task details for a chosen agent conversation, then add private conversation history and explicit, deduplicated task sends.

**Architecture:** A separate backend Gateway client supplies normalized, protected control APIs. The existing roster/collector/public socket remain independent. The existing agent modal gains Task and Agent tabs in the first delivery, then Conversation in the second; private streaming uses a separate authenticated Socket.IO namespace.

**Tech Stack:** Existing React 19, TypeScript, Express, Socket.IO, Vitest and Node WebSocket/crypto/filesystem APIs; no new runtime dependencies.

**Spec:** [Approved task-controls design](../specs/2026-10-23-task-controls-design.md). User approved the presented design/mockup with “this looks awesome!” on 2026-10-23. This plan still awaits its own execution handoff.

## Global Constraints

- Node `^22.22.2 || ^24.15.0 || >=26.0.0`; run `npm ci` only in the execution worktree. Preserve the design-preview worktree and its running service.
- No private compiled OpenClaw imports; use public protocol 4. Installed version verified as 2026.10.3. Recheck supported methods/scopes on reconnect.
- Delivery 1 requests only `operator.read`; Delivery 2 adds `operator.write`. Never request `operator.admin` or use the reserved internal backend-helper exception.
- `OPENCLAW_GATEWAY_URL` opts in; Gateway credentials stay server-side. Private device directory/files use 0700/0600. A separate `PIXEL_CONTROL_TOKEN` protects task/conversation APIs; browser retention is tab memory only.
- HTTPS normally; loopback HTTP for development; `CONTROL_ALLOW_TAILNET_HTTP=true` permits only direct local-interface `tailscale0` plus Tailscale-peer connections. Forwarded headers cannot establish this exception.
- RPC timeout 5 seconds, at most 8 pending RPCs, reconnect cap 30 seconds. Private responses at most 256 KiB; normalized cache at most 100 entries, 60-second expiry and 2-second successful-read reuse.
- Conversation list pages: 25 entries. History pages: 50 records; automatic request discovery: 200 records; explicit discovery ceiling: 2,000 records. Refresh open/visible Task every 5 seconds, without overlapping a target's reads.
- No percentage completion inference, raw tool arguments/results, private reasoning/system messages, filesystem paths, credentials or diagnostic objects in task DTOs or logs.
- Desktop drawer up to 560px; mobile uses the existing sheet and one scroll area; all controls at least 44px. Preserve modal focus/Escape/return behavior and the roster's independent connection badge.
- Explicit text sends only, at most 8,000 characters. Enter inserts a newline; Ctrl/Cmd+Enter sends. Busy sends are follow-ups, never automatic interruption or external-channel delivery.
- Use stable submission identities and original idempotency keys for uncertain retries. No automatic replay or content-based deduplication. Do not send test tasks to real agents.
- Preserve user layouts/preferences, current collector timer, Gateway binding/auth/global models, and the existing live/preview services. Verify `gh api user --jq .login` is exactly `SweetSophia` before GitHub writes.

## Review Focus

- Busy channel runs may omit exact run IDs: show Running with unknown task identity instead of selecting a guessed run — Tasks 1 and 3.
- A reset/branch/session replacement can finish while reads or drafts are pending: never apply the old result or send the old draft into the replacement — Tasks 3, 4, 6 and 8.
- A long tool-only history window can hide the request: discover within explicit bounds and display missing/truncated facts honestly — Tasks 1, 3 and 4.
- Lost admission/persistence acknowledgments can duplicate instructions or new conversations: preserve submission identity and reconcile exact receipts — Tasks 6 and 8.
- Wrong agent/global-session ownership, read-only grants, forged proxy transport and reconnecting credentials must not disclose private content or enable writes — Tasks 2, 3 and 7.

## File and interface map

Paths below are relative to the execution worktree. New modules live under `server/control/` and `src/control/`; the entrypoint only mounts and shuts them down.

| Unit | Files and responsibility |
| --- | --- |
| Shared contract | `shared/control.ts`, `shared/control.test.ts`: bounded DTOs and browser response guards, separate from `AgentState`. |
| Source projection | `server/control/projection.ts`, `.test.ts`: source facts/messages to private display DTOs. |
| Gateway transport | `server/control/config.ts`, `deviceIdentity.ts`, `gatewayClient.ts` and their tests: opt-in configuration, private identity, signed connection and RPC lifetime. |
| Access and reads | `server/control/access.ts`, `validation.ts`, `taskService.ts`, `routes.ts` and their tests: transport/key/rate gates, target membership, paging/caching, private REST. |
| Browser access/data | `src/control/ControlAccess.tsx`, `api.ts`, `useTaskDetails.ts` and tests: in-memory unlock, validated fetches and scoped task lifecycle. |
| Panel | `src/components/TaskDetails.tsx`, `.css`, `.test.tsx`; modify `AgentDetailPanel.tsx/.css`, `App.tsx`, `accessibility.test.tsx`: actual task display and existing Agent view. |
| Sending | `server/control/sendService.ts`, `.test.ts`; extend `routes.ts`, shared contracts and Gateway allowed methods. |
| Private streaming | `server/control/conversation.ts`, `.test.ts`; `src/control/useConversation.ts`, `.test.tsx`: scoped namespace subscription and normalized message updates. |
| Composer | `src/components/AgentConversation.tsx`, `.css`, `.test.tsx`; extend existing panel tabs. |
| Integration/docs | Minimal `server/index.ts` mounting/lifecycle; `README.md`, `CONTRIBUTING.md`, `AGENTS.md`; existing correlation/server/client regression tests as needed. |

Define these cross-task interfaces in Task 1; later tasks must use their exact names:

```ts
type ControlRunState = 'running' | 'completed' | 'failed' | 'aborted' | 'not-running' | 'unknown';
type ControlGatewayState = 'disabled' | 'connecting' | 'ready' | 'pairing-required' | 'auth-error' | 'unsupported' | 'unavailable';
interface ControlTarget { agentId: string; sessionKey: string; sessionId: string; lifecycleRevision?: number; branchId?: string; activeLeafEntryId?: string }
interface ControlStatus { configured: boolean; state: ControlGatewayState; canRead: boolean; canSend: boolean }
interface ControlSource { state: 'current' | 'stale'; observedAt: number }
interface ControlSession extends ControlTarget { name: string; channel?: string; isChild: boolean; hasActiveRun: boolean | null; updatedAt?: number; snapshotAt?: number; model?: string; sendDisabledReason?: string }
interface ControlSessionPage { sessions: ControlSession[]; nextCursor?: string; source: ControlSource }
interface ControlActivity { id: string; runId?: string; toolCallId?: string; toolName: string; at?: number; outcome: 'pending' | 'success' | 'error' | 'unknown' }
interface ControlMessage { id: string; role: 'user' | 'assistant'; text: string; truncated: boolean; at?: number; runId?: string; messageSeq?: number; submissionId?: string }
interface ControlTaskRequest extends ControlTarget { cursor?: string }
interface ControlTaskSnapshot { target: ControlTarget; source: ControlSource; hasActiveRun: boolean | null; activeRunIds?: string[]; runId?: string; runState: ControlRunState; request?: ControlMessage; requestAssociation: 'run' | 'latest-recorded' | 'unknown'; requestState: 'found' | 'not-loaded' | 'limit-reached' | 'unavailable'; startedAt?: number; endedAt?: number; latestResponse?: ControlMessage; result?: ControlMessage; activity: ControlActivity[]; children: ControlSession[]; childrenComplete: boolean; loadedRecords: number; nextCursor?: string; model?: string }
interface ControlHistoryPage { target: ControlTarget; source: ControlSource; messages: ControlMessage[]; nextCursor?: string; sendDisabledReason?: string }
interface ControlSendRequest { agentId: string; target?: ControlTarget; newConversation: boolean; message: string; idempotencyKey: string }
interface ControlSendReceipt { target: ControlTarget; idempotencyKey: string; phase: 'accepted' | 'persisted' | 'unknown'; runId?: string; messageId?: string; messageSeq?: number }
type ControlErrorCode = 'disabled' | 'locked' | 'transport-required' | 'pairing-required' | 'scope-required' | 'unsupported' | 'unavailable' | 'invalid-source' | 'invalid-target' | 'session-changed' | 'invalid-request' | 'rate-limited' | 'outcome-unknown';
interface ControlErrorBody { error: string; code: ControlErrorCode }
```

`ControlErrorBody.error` is bounded, authored product copy; never copy raw Gateway diagnostics into it. String guard ceilings: agent ID 64, session key 512, session ID 128, opaque cursor 2,048, display name 256, message text 16,000 and tool name 128 characters. Return explicit truncation for clipped text. Keep at most 50 activity/message rows per response. Validate finite non-negative timestamps/revisions and safe integer sequence values. Drop unknown source fields and reject invalid core identities. Validate JSON byte size with UTF-8, not character count.

`branchId` is used only when supplied as a canonical stable branch identity by the source. `activeLeafEntryId` is a concurrency precondition, not a stable branch ID: ordinary transcript appends must not look like conversation replacement. Lifecycle/branch-change facts invalidate prior snapshots; unknown facts stay unknown. When a history page needs text clipping to fit its byte budget, retain its message identities and truncation flags rather than silently skipping records behind an advanced cursor.

## Delivery 1

### Task 1: source-backed projection and bounded shared contracts

**Files:** Create `shared/control.ts`, `shared/control.test.ts`, `server/control/projection.ts`, `server/control/projection.test.ts`.

**Interfaces:** Produce DTOs above plus `parseControlStatus(value: unknown): ControlStatus | null`, `parseControlSessionPage(value: unknown): ControlSessionPage | null`, `parseControlTaskSnapshot(value: unknown): ControlTaskSnapshot | null`. Server produces `projectSession(value: unknown, agentId: string): ControlSession | null` and `projectTask(input: { target: ControlTarget; session: unknown; history: unknown; children: unknown[]; childrenComplete: boolean; loadedRecords: number; nextCursor?: string; observedAt: number }): ControlTaskSnapshot`.

- [x] Write failing tests with synthetic records: `expect(projectTask(busyWithoutExactIdentity).runState).toBe('running')`, `expect(result.runId).toBeUndefined()` and `expect(result.requestAssociation).not.toBe('run')`. Assert `undefined` exact IDs stay undefined, whereas an explicitly empty exact set stays empty.
- [x] Add tests that a failed tool followed by a correlated completed run stays Completed, `toolUse` text is not a final result, and a matching in-flight or canonical last-run ID selects only its own messages. With no canonical run ID an idle session's task state is Unknown; an identified inactive run without a terminal outcome is Not running. Private `thinking`, system records, tool arguments/output and diagnostic keys must be absent after serialization.
- [x] Add bounded-data tests: missing request in 50 tool-only records, 16,001-character text marked truncated, malformed identities/timestamps, poisoned reserved keys, and a 256 KiB response ceiling. Distinguish context usage from task progress.
- [x] Run `npm test -- shared/control.test.ts server/control/projection.test.ts`; confirm RED before implementation. Implement only the DTO guards and pure projections, then rerun for GREEN and `npm run typecheck`.
- [x] Commit the contracts/projector and tests together: `feat: project verified task facts into bounded control data`.

### Task 2: opt-in signed Gateway connection

**Files:** Create `server/control/config.ts`, `deviceIdentity.ts`, `gatewayClient.ts` and corresponding `.test.ts` files. Gateway tests use the Node test environment. Keep a synthetic raw-WebSocket HTTP-upgrade fixture local to `gatewayClient.test.ts`; it must verify real client frames/signatures rather than bypass the handshake.

**Interfaces:** Produce `loadControlConfig(env: NodeJS.ProcessEnv, dataDir: string): ControlConfig`, `loadOrCreateDeviceIdentity(directory: string): DeviceIdentity`, and `createControlGateway(config: ControlConfig): ControlGateway`. Define `ControlConfig`, `DeviceIdentity`, `GatewayEvent = { event: string; payload: unknown; seq?: number }` and `ControlGateway` in these modules. Gateway methods: `start(): void`, `status(): ControlStatus`, `request(method: ControlMethod, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>`, `onEvent(listener: (event: GatewayEvent) => void): () => void`, `close(): void`. Delivery-1 `ControlMethod` is a closed union of `sessions.list`, `sessions.describe`, `chat.history`, `sessions.subscribe`.

- [x] Write RED tests for disabled configuration/no outbound socket; reject remote plain WebSocket URLs, URL credentials and fragments. Accept configured encrypted endpoints and loopback plain WebSocket, without browser overrides.
- [x] Write real-signature tests: Ed25519 identity persists with 0700/0600 permissions, ID is SHA-256 of raw public-key bytes, and the signed v3 payload binds device ID, client `cli`, mode `backend`, role `operator`, ordered scopes, challenge timestamp, auth token, nonce, normalized platform and empty optional device family. Use the challenge timestamp, not a local-time substitute. Invalid/corrupt stored identity fails closed rather than silently rotating.
- [x] Pin protocol 4 and required hello fields/methods/read scope. Test malformed challenges, denied pairing, wrong token, absent scope, an unexpected protocol, event sequence gaps, a late response from a previous socket generation, close with pending RPCs, 5-second expiry, the 9th concurrent request, and reconnect backoff capped at 30 seconds. Decode at most 2 MiB per incoming frame; reject larger/malformed frames before projection. No write method is callable in this delivery.
- [x] Run `npm test -- server/control/config.test.ts server/control/deviceIdentity.test.ts server/control/gatewayClient.test.ts`; confirm RED, implement using Node WebSocket and crypto with a distinct private device/token store, then confirm GREEN. Source references are the installed public client identity/device-auth contract and the spec's protocol links; copy protocol semantics, not private imports.
- [x] Commit: `feat: add a scoped read-only Gateway connection`. First foundation PR may include Tasks 1–2 behind disabled-by-default configuration; split further if its reviewable diff requires it.

### Task 3: protected task reads, membership, pagination and cache

**Files:** Create `server/control/access.ts`, `validation.ts`, `taskService.ts`, `routes.ts` and tests. Modify only the control mounting/teardown areas of `server/index.ts` before its `/api` JSON 404 boundary.

**Interfaces:** Produce `createTaskService(gateway: ControlGateway, registeredAgentIds: () => ReadonlySet<string>): TaskService` with `listSessions(agentId: string, cursor?: string, signal?: AbortSignal): Promise<ControlSessionPage>`, `getTask(input: ControlTaskRequest, signal?: AbortSignal): Promise<ControlTaskSnapshot>`, `clear(): void`, `close(): void`; `createControlRouter(options: { gateway: ControlGateway; tasks: TaskService; config: ControlConfig }): express.Router`. `access.ts` produces middleware `createControlAccess(config: ControlConfig): express.RequestHandler`; `validation.ts` produces `parseTaskRequest(agentId: string, body: unknown): ControlTaskRequest | null`.

- [x] Write RED HTTP tests: absent/bad/oversized bearer keys, fixed-length digest comparison behavior for equal and different input lengths, denied remote HTTP, spoofed forwarded HTTPS with no proxy trust, and the explicit Tailnet exception requiring both actual socket addresses and the real interface inventory. A correct key over ordinary LAN HTTP still fails before Gateway work.
- [x] Pin these routes: `GET /api/control/status`, `GET /api/control/agents/:id/sessions?cursor=...`, `POST /api/control/agents/:id/task`. Status may report only disabled configuration without credentials; configured source/capability facts require access. All private responses use `no-store`; origin guards apply to POST. Use separate in-memory per-client limits: 60 pre-auth requests/minute, 120 authenticated reads/minute; reject excess before expensive RPC work. Do not log headers, bodies, session keys or source error text.
- [x] Write target tests: unknown registered agent, agent/key conflict, changed observed session ID, explicit branch/lifecycle changes and ambiguous unqualified/global keys. Verify ordinary appends advance the leaf without changing the target's stable identity. Supply explicit owner parameters only where the documented method supports them; otherwise report unsupported ownership instead of falling back to the Gateway's default agent. Recheck canonical membership before source history reads and abort pending local work when its HTTP requester leaves.
- [x] Write history tests: page 50 records, automatically seek up to 200, explicit earlier pages add at most 50 up to 2,000, and no inferred request on exhaustion. Bind opaque cursors to exact target/lifecycle and loaded count; reject cross-target/oversized/expired cursors. Verify default current/last-run policy from the spec, preserved exact selection, and loaded-child subset labels.
- [x] Write cache tests: coalesced reads, two-second reuse, 60-second expiry, eviction above 100 entries, normalized-size ceiling 256 KiB, source-event invalidation, stale same-target success after a refresh failure, and no stale reuse after reset/replacement. Network request completion order cannot override newer Gateway sampling/revision facts.
- [x] Run `npm test -- server/control/access.test.ts server/control/taskService.test.ts server/control/routes.test.ts`; confirm RED, implement dedicated modules and minimal entrypoint lifecycle wiring, then confirm GREEN with existing server auth/rate-limit/correlation tests. Closing the real HTTP server must dispose the Gateway client even when `startServer()` was not called by a test.
- [x] Commit: `feat: serve authenticated source-backed task details`.

### Task 4: private browser access, data lifecycle and Task/Agent tabs

**Files:** Create `src/control/ControlAccess.tsx`, `api.ts`, `useTaskDetails.ts` and tests; `src/components/TaskDetails.tsx/.css/.test.tsx`. Modify `AgentDetailPanel.tsx/.css`, `App.tsx` and `accessibility.test.tsx`.

**Interfaces:** Produce `ControlAccessProvider` and `useControlAccess()` exposing `{ state: 'locked' | 'unlocked'; status: ControlStatus | null; unlock(key: string): Promise<void>; lock(): void; request(path: string, init?: RequestInit): Promise<unknown>; generation: number }`. Mount the provider around App's children, outside the modal lifecycle. Produce `useTaskDetails(options: { agentId: string; initialSessionKey: string; active: boolean }): TaskDetailsState`, whose named actions are `selectSession(target: ControlTarget)`, `refresh()`, `loadMoreSessions()`, `loadEarlier()`. `TaskDetailsState` carries selected target, session page, task snapshot, loading/error/access state and those actions. `TaskDetails` consumes the selected agent's ID/initial key and active-tab flag. Keep existing Agent metadata inside the same modal shell.

- [ ] Write RED tests for unlocked-key retention across modal close/reopen but no local/session storage, lock/auth-failure abort and cache clearing, and a late successful unlock/read from an older credential generation being discarded. The API helper rejects external URLs and paths outside `/api/control/` before attaching the bearer key. Unconfigured integration explains setup; unsafe transport explains the connection requirement without soliciting a key.
- [ ] Test exact initial roster-key selection, newest visible non-child fallback, child-only fallback explanation, 25-entry list pagination, and no automatic conversation switch as other sessions update. Replaced/removed sessions require a new explicit selection. A same-key/new-ID response cannot replace the old target silently.
- [ ] Use fake timers plus real visibility events to prove one 5-second refresh while open/visible, no overlapping target reads, no refresh when hidden/closed/locked or on Agent tab, and correct teardown on tab/agent/target changes. Cover stale-but-preserved facts and ignored out-of-order snapshots separately from roster connectivity.
- [ ] Test source-backed Task display, missing/limited history, tool error versus run result, unknown current-run identity, selected-conversation model, text wrapping, React escaping, and scoped updates without focus theft. Preserve modal close/Escape/focus return; give Task/Agent tabs keyboard arrows/Home/End and 44px targets. Keep the public agent store/socket untouched.
- [ ] Run focused access/hook/component/accessibility tests; record RED, implement, then confirm GREEN with `npm run typecheck`. Update `README.md` with configuration, unlock, pairing and transport setup; `CONTRIBUTING.md` with native browser checks; `AGENTS.md` with new boundaries. Commit: `feat: show verified task details in the agent drawer`.

### Task 5: verify and release task details

**Files:** Update this plan's evidence checkboxes; only change implementation files if verification exposes a defect.

**Interfaces:** Consumes Tasks 1–4 and produces a reviewed, deployed Delivery 1 with read-only Gateway authority. No send controls are enabled.

- [ ] Run `npm run typecheck`, `npm run test:coverage`, `npm run build`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate` and `git diff --check`; require successful exits and repository coverage floors. Do not add tests merely for plan/mockup documentation.
- [ ] Use an isolated fixture preview at 320/390/768/1024/1440px and short landscape. Exercise native unlock, conversation selection, refresh, history loading, tabs, modal focus and all unavailable/stale states. Check 44px targets, one reachable scroll area, no horizontal overflow, no public-socket private events and no browser errors.
- [ ] Conduct a live read-only Gateway check with its distinct approved read device; never issue a real task. Check returned text/run identity against the selected conversation without committing private fixtures. Confirm collector/room/canvas behavior and persisted layout/preferences remain intact.
- [ ] Follow the selected execution method's independent review gate and existing bot-review policy. Address valid findings, require green current-head checks and no new valid comments, then merge Delivery 1 in dependency order. Take a fresh backup, deploy the tested artifacts and opt-in read configuration, and verify actual live behavior before proceeding to Delivery 2.

## Delivery 2

### Task 6: explicit follow-up sends with stable admission identity

**Files:** Create `server/control/sendService.ts/.test.ts`; extend `shared/control.ts` guards, `gatewayClient.ts`, `config.ts` and `routes.ts` with corresponding tests.

**Interfaces:** Produce `createSendService(gateway: ControlGateway, tasks: TaskService): SendService` with `send(input: ControlSendRequest, signal?: AbortSignal): Promise<ControlSendReceipt>`, `close(): void`. Add `POST /api/control/agents/:id/send`. Extend `ControlMethod` with only `chat.send` and `sessions.create`; enable writing through explicit `CONTROL_SEND_ENABLED=true`, requesting read/write scopes only when enabled. Default remains false.

- [ ] Write RED tests for missing write grant, target send-disabled reason, invalid/mismatched/replaced target, empty or 8,001-character text, unknown fields, and 11th send within a minute. Reuse the same transport/access guards; no body-controlled RPC/URL/executable is accepted.
- [ ] Pin an idle send and busy follow-up to exact session identity and `queueMode: 'followup'`. Verify the installed documented external-delivery suppression field/semantics before enabling channel-backed targets. Tests must assert no channel dispatch request; if suppression cannot be established, return Unsupported for such a target. No Stop/Steer/inject call is sent.
- [ ] Test duplicate clicks/in-flight retries share one submission. Forward the original `idempotencyKey` and reconcile source `messageSeq`/message/submission identity; do not infer persistence from `status: started`. A timeout/disconnect after write returns `outcome-unknown`, not an automatic second send. A matching persisted receipt advances Accepted to Persisted exactly once.
- [ ] For New conversation derive a stable agent-qualified key from the SHA-256 digest of the original submission ID, create/adopt that exact key through the documented create method, then send with the same submission identity. Submission IDs accept the bounded `newEntityId('send')` format, including its non-secure-context fallback; they need not be UUIDs. Test lost create acknowledgment, lost send acknowledgment and two retries: one conversation and one admitted prompt. Never reset an existing session.
- [ ] Run `npm test -- server/control/sendService.test.ts server/control/routes.test.ts server/control/gatewayClient.test.ts shared/control.test.ts`; confirm RED, implement the service/closed method extensions, then GREEN. Keep bounded receipt metadata in memory, not persisted prompt/transcript bodies. Commit: `feat: send explicit deduplicated agent follow-ups`.

### Task 7: authenticated, target-scoped conversation history and streaming

**Files:** Create `server/control/conversation.ts/.test.ts`; extend control routes, shared response guards and Gateway method union; minimally mount/close the namespace in `server/index.ts`.

**Interfaces:** Produce `createConversationService(gateway: ControlGateway, tasks: TaskService): ConversationService` with `history(target: ControlTarget, cursor?: string, signal?: AbortSignal): Promise<ControlHistoryPage>`, `watch(target: ControlTarget, listener: (event: ControlConversationEvent) => void): () => void`, `close(): void`; and `mountControlNamespace(io: SocketIOServer, options: { config: ControlConfig; tasks: TaskService; conversations: ConversationService }): () => void`. Define `ControlConversationEvent = { target: ControlTarget; kind: 'messages' | 'invalidated' | 'unavailable'; source: ControlSource; messages?: ControlMessage[] }` in shared contracts. Add `POST /api/control/agents/:id/history` and only `sessions.messages.subscribe`/`sessions.messages.unsubscribe` to allowed Gateway methods.

- [ ] Write RED real Socket.IO client tests for absent/bad credentials, disallowed origin/transport, unknown agent, wrong agent/global ownership, target replacement, lock/disconnect and credential generation changes. Subscribe only after canonical membership checks; source subscriptions are reference-counted and removed when the last watcher leaves.
- [ ] Test text-only user/assistant history, explicit 50-record pagination and truncation. No reasoning, system messages, tool arguments/output, delivery destinations or raw event envelopes reach a private client, and none reach the public namespace at all.
- [ ] Test event generation/sequence and active-leaf changes: wrong-target, previous-socket and old-lifecycle events are dropped; gaps invalidate/refetch instead of inventing merged history. Reconnect revalidates membership and resubscribes to only currently authorized targets. Reads/events never start an agent turn.
- [ ] Run focused conversation/route/Gateway tests; confirm RED, implement, then GREEN and typecheck. Commit: `feat: stream private conversation updates by exact session`.

### Task 8: conversation tab, drafts and explicit composer

**Files:** Create `src/control/useConversation.ts/.test.tsx`, `src/components/AgentConversation.tsx/.css/.test.tsx`; extend `src/control/api.ts`, existing panel tabs and accessibility tests.

**Interfaces:** Produce `useConversation(target: ControlTarget | null, active: boolean): ConversationState` with messages, status/error, exact-target draft and submission state plus `setDraft(text: string)`, `send()`, `retryPending()`, `newConversation()`, `loadEarlier()`. `AgentConversation` renders it within the existing shared modal and access provider. Define browser pending submissions by immutable original idempotency key; `newEntityId()` supplies non-secure-context-safe identities, with server validation of the accepted submission format.

- [ ] Write RED tests: Enter inserts newline; Ctrl/Cmd+Enter or explicit Send makes one manual request; 8,000-character limit; busy work displays Send follow-up; disconnection/lock/missing scope/target policy disables send with an authored reason. No automatic reconnect send occurs.
- [ ] Test drafts retained across target switches, rejected sends and reconnects, keyed by exact target. A changed session ID/branch fences the old draft and pending request; require explicit user choice before reuse. Keep at most one unsettled submission per target; while its outcome is unknown, Retry uses that submission's original key and text.
- [ ] Test Accepted, Persisted and Outcome unknown separately. Preserve a recovery draft until a canonical persistence receipt; clear the visible sent draft only after the matching receipt. Duplicate message events or receipt refreshes cannot create a second bubble. A user edit cannot mutate the immutable text of an uncertain submission.
- [ ] Test explicit New conversation chooses the selected agent, never changes the existing conversation, and handles uncertain creation/admission without another key. Verify private Socket.IO teardown on lock/close/target changes and no task/message storage in localStorage/sessionStorage or public store caches.
- [ ] Run focused hook/composer/accessibility tests; confirm RED, implement and confirm GREEN with typecheck. Add the Conversation tab after Task, with the same keyboard/focus/44px/wrapping behavior. Update user/setup documentation and commit: `feat: add agent conversations and explicit task sends`.

### Task 9: verify and release conversation/send controls

**Files:** Update execution evidence in this plan and only fix demonstrated defects.

**Interfaces:** Consumes Delivery 1 and Tasks 6–8; produces separately reviewed Delivery 2 with explicit write configuration and the approved exact-target send behavior.

- [ ] Repeat typecheck, full coverage, build, both audits and diff checks after these new changes. Require actual successful results, not Delivery-1 evidence.
- [ ] On a controlled Gateway fixture, use native browser actions to send, queue a follow-up, switch drafts, page history and create a conversation. Inject connection loss around create/admission/persistence boundaries; verify one conversation/one send, original-key Retry, retained drafts and no external delivery. Check desktop/mobile/short-window layout, focus, keyboard, escaping and no browser errors.
- [ ] Independently review the complete second-delivery diff and current-head bot findings. Address valid findings and merge only when current checks are green. Split backend-enabled-but-UI-hidden and frontend work into separate PRs if size warrants it; keep `CONTROL_SEND_ENABLED=false` until the complete reviewed delivery is ready.
- [ ] Back up current live data again, deploy the exact tested artifacts/configuration, verify read-only real Gateway behavior and source freshness, and hand the explicit real-task send check to the user. Never issue a real task or external message as an automatic smoke test. Preserve the design-preview service and existing user data.

## Self-review and execution handoff

Plan self-review completed: every design section maps to Tasks 1–9; shared interfaces use consistent names; each Review Focus input has owning tests; the two deliveries have separate verification/review/release gates. The optional future capabilities remain outside these deliveries. The source tree is still documentation/prototype only.

Recommended execution: **Native**, implementing the tasks in this session, with an independent whole-branch review before each delivery merges. The tasks share protocol/identity/data-contract decisions, so keeping one implementer reduces interface drift. **Subagent-driven** remains available if the user prefers fresh implementers and reviewers per task.

User review of this plan and selection/confirmation of execution method are required before product implementation under the writing-plans skill. Once chosen, preserve the method through both deliveries.
