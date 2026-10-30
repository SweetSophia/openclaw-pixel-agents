# Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inspect and explicitly change the selected live conversation's native model with honest concurrency and outcome semantics.

**Architecture:** Extend optional private Gateway model capabilities and a closed model service/router, then integrate a live-only Conversation control through the existing private access provider. Native model owners remain authoritative; no generic patch proxy or direct host writes.

**Tech Stack:** Existing TypeScript, Express, protocol-4 WebSocket, React, Vitest/Testing Library. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-model-selection.md`

## Global Constraints

- Preserve current main history/Stop/Steer/approvals, credentials, unrelated worktrees and public roster isolation. Legacy `model-selection-20261026` at `85e50f7` is read-only reference, never a divergent-base cherry-pick.
- Use existing paired `operator.read`/`operator.write` and write opt-in; no admin, silent grant upgrade, generic RPC, global model change, reset, task, real model mutation, native installation edit, deployment or publication.
- User-approved native semantics: block known-busy/unknown activity before dispatch, but warn that work racing the idle check can switch/restart. No future-turn-only or exclusive native-client guarantee.
- Bounds: 500 choices; model IDs 512 characters; labels 128; observation identities 128; observations 100 for 60 seconds; four concurrent reads; ten new apply operations per minute; 1,000 process-local attempted operation identities, fail closed without eviction at capacity; existing private response-byte limit.
- Private payloads are tab-memory-only; canonical network target projection at both requests; historical/new drafts non-actionable; source/authority/identity lifecycle fencing; unknown native outcomes never replay automatically.
- Native request/response details must match inspected installed 2026.10.3 primary source, including `includeDetails: true` (not unsupported `preparedOnly`), model-policy capability, exact preference receipt checks and session-only non-admin scope.

## Review Focus

- A native receipt and subsequent describe agree with each other but not the requested model/default: never report confirmed (Task 1).
- Source invalidation/reconnect or HTTP abort occurs after native admission: retain attempted identity and never dispatch the same confirmation twice (Tasks 1–2).
- Busy/permission/target changes commit while confirmation is open, before passive effects: submit nothing (Task 2), with fresh server checks (Task 1).
- Runtime `ControlSession` metadata crosses a structural TypeScript type: serialize only canonical target fields; server remains closed (Tasks 1–2).
- Unknown outcome is followed by a hidden/visible refresh or remount: never silently clear uncertainty or replay; explicit Refresh and fresh confirmation only (Task 2).

### Task 1: Scoped native model boundary

**Files:** Create `shared/controlModels.ts`, `.test.ts`, `server/control/modelService.ts`, `.test.ts`, `server/control/modelRoutes.test.ts`; modify `shared/control.ts`, `server/control/{gatewayClient.ts,gatewayClient.test.ts,routes.ts}`, `server/index.ts`.

**Interfaces:** Consume `ControlGateway`, `TaskService.verifyTarget`, protected middleware and `ControlTarget`. Produce optional `ControlGateway.modelCapabilities(): {canRead:boolean;canChange:boolean}` without changing existing panel readiness; closed models read/apply POSTs; `createModelService(gateway,tasks): ModelService` with `read(target:unknown,signal?:AbortSignal):Promise<ControlModelSnapshot>`, `select(value:unknown):Promise<ControlModelOutcome>`, `close():void`. Produce `ControlModelChoice {id,label,selectable,available:boolean|null}`, `ControlModelSnapshot {target,selectionId,observedAt,currentModel:string|null,choices,canChange,disabledReason}`, `ControlModelSelection {target,selectionId,model:string|null}`, `ControlModelOutcome {target,outcome:'confirmed'|'unknown',snapshot?}`, parsers for each request/response, `parseModelTarget`, `modelTargetIdentity`, `isControlModelId`, `CONTROL_MODEL_LIMITS`. Disabled reasons are `busy|activity-unknown|read-only|permission|selection-unknown|unsupported|null`. New closed error codes `model-denied`, `model-busy` leave unrelated private access usable. A confirmed outcome requires a reconciled snapshot.

- [ ] Write failing shared/configured catalog/native framing/service/route tests. Assert `models.list` emits only canonical agent/session/configured/includeDetails fields; signed connect advertises policy cap; models can read without send capability; admin grants cannot patch; method denial does not lock other panels. Cover malformed/oversized/bidi IDs/duplicates, scope and manual-policy/readiness separation, all bounds, exact target and route binding, expiry, fresh permission/busy checks, preflight changed model and branch/lifecycle, source invalidation, abort, concurrent/coalesced attempts and process-local no-replay. Include wrong-but-self-consistent receipts, default reset provenance and explicit pin equal to configured default (non-null RPC must retain a user override, not accept reset semantics).
- [ ] Run `npm test -- shared/controlModels.test.ts server/control/modelService.test.ts server/control/modelRoutes.test.ts server/control/gatewayClient.test.ts`; retain meaningful RED before production edits, not only import failures.
- [ ] Pin the model-only string boundary with regressions: reject a catalog/request ID interpreted by the native parser as an auth-profile suffix before any patch; permit only unambiguous version/quantization suffixes. Never rely on a mismatched receipt to detect an already-dispatched profile selection.
- [ ] Implement the minimal readable boundary with the interfaces above; inspect current native source rather than copying legacy assumptions. Validate exact committed preference against request, then fresh identity/presentation; retain uncertain attempts independently of expiring observations. Wire server disposal even when tests do not call start. Preserve approvals capability and existing scope/storage invariants.
- [ ] Rerun focused tests, `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`; require pass. Record native source evidence and exact UI contract in the task report.
- [ ] Verify GitHub CLI identity `SweetSophia`; commit `feat: add scoped conversation model boundary` (include plan/spec).

### Task 2: Accessible live conversation model control

**Files:** Create `src/control/useConversationModels.ts`, `.test.tsx`, `.integration.test.tsx`, `src/components/ConversationModel.tsx`, `.css`, `.test.tsx`; modify `src/control/{api.ts,api.test.ts}`, `src/components/AgentDetailPanel.tsx` and relevant history/run-control/selection tests. Task 1 shared interfaces are binding.

**Interfaces:** Consume Task 1 parsers/capability/error/opaque observation and `ControlAccess`; produce `useConversationModels(target:ControlTarget|null,active:boolean)` and `ConversationModel({target,active,readOnly?})` integrated in live Conversation only. Hook owns model read/draft/confirmation outcome lifecycle; component owns local accessible confirmation. Existing parent remains selection/history/draft owner. Project targets to canonical fields at both read/apply request boundaries; no new public sockets or persistence.

- [ ] Write failing real-hook/component/parent tests for current model, policy/readiness and default option, explicit inspect/apply, immutable confirmation, exact race warning, Cancel-first focus, local forward/reverse Tab/Escape/restoration fallback, phone-safe long IDs, stale/expired facts and original timestamps. Cover pre-passive target/permission/observation replacement, synchronous duplicate clicks, historical/new draft suppression, canonical target serialization, authority/identity error clearing, transient stale state, source loss/late replies, lock/credentials/hide/close/remount, admitted mutation not falsely cancelled and explicit Refresh after unknown.
- [ ] Run `npm test -- src/control/useConversationModels.test.tsx src/control/useConversationModels.integration.test.tsx src/components/ConversationModel.test.tsx`; capture meaningful RED.
- [ ] Implement minimal readable UI and hook. Confirmation must include: **Work starting after the idle check may switch models or restart under the Gateway's native behavior. This is not a future-turn-only guarantee.** Keep current model, requested preference and execution claims distinct. In historical selection and new-conversation draft, render explanation only, no model reads/mutations.
- [ ] Rerun focused tests, typecheck, full suite and diff checks; commit `feat: select live conversation models with confirmation`.

### Task 3: Setup documentation and delivery qualification

**Files:** Modify `docs/task-access-setup.md`, `docs/configuration.md`, `docs/revamp-status.md`, `docs/superpowers/plans/2026-10-26-revamp-phase-two.md`, this plan. Temporary fixture/proof belongs only in this plan's ignored workspace, not production.

**Interfaces:** Consume accepted Tasks 1–2. Produce honest setup, authority/race/default/unknown limitations and exact-source release evidence, then source-integration status under existing roadmap authorization.

- [ ] Document native per-conversation behavior and approved live-switch race, write scope, optional support, admin refusal, current observation versus execution, default reset, policy/readiness, uncertain reconciliation and process-local no-replay limitation; no live delivery or npm claims.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate`, `git diff --check`, plus documented exact-source Docker API/SPA startup probes. No weakened gates.
- [ ] Use agent-browser skill and an isolated synthetic fixture executing real panel/hooks. Hard-assert desktop/phone/short-window native hit geometry; Cancel-first/full forward/reverse Tab/Escape/local restoration; immutable confirmation and race warning; historical/draft/busy suppression; default/confirmed/unknown/late response/lifecycle behavior; privacy/storage/network/console and scoped accessibility. Inspect screenshots, retain any contrary traces and close owned browser/server/container. No live Gateway/control credentials or native model mutation. Require exact final-source requalification for material fixes.
- [ ] Commit docs as `docs: document conversation model selection`; complete task and final whole-branch independent reviews/fixes, push Ready PR, assess current-head bot comments, allow full 15-minute window, pass protections, merge without bypass and verify exact post-merge main CI/CodeQL. Only then reconcile complete-source checkboxes; no deployment/publication implied.

## Self-review

Task 1 owns native authority, sanitization and operation lifecycle; Task 2 consumes its closed contract and owns accessible live-only lifecycle; Task 3 qualifies final accepted behavior and documents only established facts. Every Review Focus case has explicit owning regressions. Native live-switch semantics are the user's approved exception to the legacy draft's impossible future-turn-only promise, not an undocumented implementation shortcut.
