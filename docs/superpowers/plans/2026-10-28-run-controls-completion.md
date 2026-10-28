# Stop and Steer Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver exact-run Stop and explicit conversation steering on current `main`, preserving the merged run-history boundaries and never controlling historical or ambiguous work.

**Architecture:** Extend the private Gateway adapter with one closed `chat.abort` service/route and extend the existing idempotent `chat.send` path with an explicit `steer` intent. The client derives Stop eligibility only from a fresh verified live task snapshot; historical selection is read-only across Task and Conversation, and uncertain mutations refresh authoritative state without automatic replay.

**Tech Stack:** TypeScript, Express, React, Vitest/Testing Library, Socket.IO client, native OpenClaw protocol-4 Gateway adapter.

**Spec:** `docs/superpowers/specs/2026-10-26-run-controls.md`

## Global Constraints

- Use no administrator scope, generic RPC endpoint, deprecated `sessions.steer`, arbitrary host access, external delivery, or live test action.
- Stop requires a fresh unchanged source-backed direct active run and final canonical target verification immediately before `chat.abort` with the exact run ID.
- Stop admission is labelled `requested`, never completed; uncertain outcomes refresh facts and are never replayed automatically.
- Steering uses `chat.send` with `queueMode: steer`, `deliver: false`, and immutable message, intent, idempotency key, and target on retry.
- Historical selections cannot stop, send, steer, or retry newer work; their drafts and selected delivery intent remain retained for return to current work.
- All mutating request bodies and native responses are bounded, allowlisted, and rejected with typed errors; missing capability or authority is reported honestly.

## Review Focus

- A run changes between the confirmation dialog and service execution: reject with `session-changed` and never call `chat.abort` for either run.
- The abort response is lost after native admission: return `unknown`, refresh facts, and do not automatically call `chat.abort` again.
- Multiple direct active-run IDs or stale/future task observations: disable Stop and make no mutation request.
- A steering retry after an uncertain response: reuse the exact original intent/message/idempotency key/target and never downgrade to follow-up.
- Switching to recorded history while a current steering draft exists: hide all mutations, preserve the draft and intent, and restore them on return to live work.

---

### Task 1: Exact-run Stop server boundary

**Files:**
- Create: `shared/controlRun.ts`
- Create: `server/control/runControlService.ts`
- Create: `server/control/runControlService.test.ts`
- Create: `server/control/runControlRoutes.test.ts`
- Modify: `shared/control.ts`, `server/control/gatewayClient.ts`, `server/control/gatewayClient.test.ts`, `server/control/routes.ts`, `server/index.ts`

**Interfaces:**
- Consumes: `TaskService.getTask(target, signal, { fresh: true, coalesce: false, requireUnchangedObservation: true })`, `TaskService.verifyTarget`, and the negotiated private Gateway status.
- Produces: `ControlStopRequest`, `ControlStopReceipt`, `currentDirectRun()`, `RunControlService.stop()`, `POST /api/control/agents/:id/stop`, and negotiated `ControlStatus.canStop`.

- [ ] Add focused failing contract/service/route tests for strict request fields, bidi-safe run IDs, 15-second freshness with at most 5 seconds future skew, exactly one direct active run, fresh unchanged re-read, final ownership/authority verification, capability denial, run replacement races, duplicate clicks, lost responses/no replay, rate limits, close/abort, and route status mapping.
- [ ] Run `npm test -- server/control/runControlService.test.ts server/control/runControlRoutes.test.ts server/control/gatewayClient.test.ts` and confirm the new cases fail for missing behavior.
- [ ] Implement the minimal shared contract, negotiated `chat.abort` allowlist/capability, service, route, and shutdown wiring. Reuse the merged shared run-ID validator rather than introducing weaker validation.
- [ ] Rerun the focused tests and `npm run typecheck`; require pass.
- [ ] Commit as `feat: add verified exact-run stop boundary`.

### Task 2: Steering and accessible live-only controls

**Files:**
- Create: `src/components/RunControls.tsx`, `src/components/RunControls.css`, `src/components/RunControls.test.tsx`, `src/components/AgentDetailPanel.runControls.test.tsx`
- Modify: `shared/control.ts`, `server/control/validation.ts`, `server/control/sendService.ts`, `server/control/sendService.test.ts`, `src/control/api.ts`, `src/control/useConversation.ts`, `src/control/useConversation.test.tsx`, `src/components/AgentConversation.tsx`, `src/components/AgentConversation.css`, `src/components/AgentConversation.test.tsx`, `src/components/TaskDetails.tsx`, `src/components/AgentDetailPanel.tsx`

**Interfaces:**
- Consumes: Task 1 Stop request/receipt and the merged run-history selection in `AgentDetailPanel`.
- Produces: `ControlSendRequest.intent?: 'followup' | 'steer'`, retained per-conversation delivery intent, accessible Stop confirmation/status, and a live-only composer/controls boundary.

- [ ] Add focused failing tests for default follow-up, explicit steering, exact retry preservation, `queueMode: steer`, omitted expected leaf only for steering, command exclusion, retained drafts/intents, duplicate clicks, focus/Escape confirmation behavior, capability/read-only reasons, and recorded-run mutation suppression.
- [ ] Run `npm test -- server/control/sendService.test.ts src/control/useConversation.test.tsx src/components/AgentConversation.test.tsx src/components/RunControls.test.tsx src/components/AgentDetailPanel.runControls.test.tsx` and confirm the new cases fail for missing behavior.
- [ ] Implement the minimal steering contract/server mapping and client controls. Keep the real composer mounted only for live work; historical mode must not start reads or mutations and must restore the same draft/intent when live work is selected again.
- [ ] Rerun the focused tests and `npm run typecheck`; require pass.
- [ ] Commit as `feat: add explicit conversation steering controls`.

### Task 3: Documentation and release qualification

**Files:**
- Modify: `docs/task-access-setup.md`, `docs/revamp-status.md`, `docs/superpowers/plans/2026-10-26-revamp-phase-two.md`
- Test: existing full repository, package, Docker, and browser acceptance surfaces.

**Interfaces:**
- Consumes: Tasks 1-2 final behavior and the already merged/published 1.7.0 plus merged PR #328 evidence.
- Produces: truthful setup/capability guidance, reconciled phase-two ledger, and release-ready verification evidence without a real mutation.

- [ ] Document exact Stop/Steer capability, authority, requested/unknown semantics, live-only controls, retry behavior, and unsupported setup states. Reconcile tasks 1 and 2 as complete and task 3 as in review; do not claim merge or deployment before evidence exists.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, both repository audit commands, `git diff --check`, and the documented Docker build/startup probes; require all gates to pass.
- [ ] In an isolated synthetic browser session, verify desktop, phone, and short-window Stop confirmation/focus/Escape, steering draft retention, historical read-only behavior, console errors, requests, and scoped accessibility. Send no real task and perform no real Stop.
- [ ] Commit documentation/qualification updates as `docs: document stop and steer controls`.
- [ ] Complete task-scoped reviews and a fresh whole-branch review, then create/update the PR, address every current-head finding, wait the full 15-minute review window after the final push, and merge only with green protections. Verify exact post-merge `main` CI/CodeQL before marking task 3 complete.

## Self-Review

Spec coverage: Task 1 owns exact-run identity, Stop capability/authority, admission semantics and no-replay uncertainty. Task 2 owns explicit steering, immutable retry identity, drafts, accessibility and historical read-only behavior. Task 3 owns honest documentation and all release gates. The five Review Focus cases are each pinned to an owning task test. The plan intentionally reuses the existing private access boundary and merged run-history contracts instead of adding scopes or generic RPC surfaces.
