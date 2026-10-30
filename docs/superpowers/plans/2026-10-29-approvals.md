# Approval Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review and decide native pending approvals safely within the selected live conversation.

**Architecture:** Extend the private Gateway allowlist with opt-in scoped approval discovery/get/resolve, then add a live-only panel using the existing private access provider. The native approval owner remains authoritative; the office validates, projects and fences decisions without inventing run identity.

**Tech Stack:** Existing TypeScript, Express, React, Vitest/Testing Library, protocol-4 WebSocket adapter. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-29-approvals.md`

## Global Constraints

- Preserve merged run history/Stop/Steer, credentials, unrelated worktrees and public roster isolation. Legacy `/home/niya/github/openclaw-pixel-agents/.worktrees/approvals-20261026` is read-only reference.
- Explicit `CONTROL_APPROVALS_ENABLED=true`; paired `operator.approvals` only; no admin, silent grant upgrade, generic RPC, standing grant, reviewer override, live approval/task, deployment or publication.
- Conversation audience, not invented exact-run attribution. Historical selection is non-actionable.
- Bounds: replay 1,000; racing events 100; page 25; observations 200/60s; four concurrent reads; attempted identities 1,000 fail closed; ten new decision operations/minute; existing response-byte budget.
- Only `allow-once`/`deny`; immutable shown identity/content; strict bounded requests/responses; native first-answer truth; uncertain decisions never replay automatically or on an identical retry.
- Private data remains tab-memory-only; no public sockets/storage/logging. Poll/read lifecycle follows existing access/visibility cancellation rules.

## Review Focus

- A replacement target or changed presentation commits while confirmation is open: submit nothing, including before passive cleanup (Task 2).
- A terminal event races an older pending replay: never resurrect it or allow a decision (Task 1).
- Native admission succeeds but response is lost: retain uncertainty and never dispatch the decision twice (Tasks 1–2).
- Existing read-only cached grant lacks approvals scope: ordinary task access still works and approvals explains setup (Tasks 1–2).
- A known approval ID is supplied for another conversation or after lifecycle/source invalidation: deny before native lookup/resolution (Task 1).

### Task 1: Scoped server approval boundary

**Files:** Create `shared/controlApprovals.ts`, `shared/controlApprovals.test.ts`, `server/control/approvalProjection.ts`, `server/control/approvalService.ts`, `server/control/approvalService.test.ts`, `server/control/approvalRoutes.test.ts`; modify `shared/control.ts`, `server/control/{config.ts,config.test.ts,gatewayClient.ts,gatewayClient.test.ts,routes.ts}`, `server/index.ts`.

**Interfaces:** Consume existing `ControlGateway`, `TaskService.verifyTarget`, protected route middleware and `ControlTarget`. Produce `ControlApproval`, `ControlApprovalPage`, `ControlApprovalResult`, closed read/inspect/resolve request parsers (including an opaque inspected-observation identity), `ApprovalService.read/inspect/resolve/close`, `ControlStatus.canReviewApprovals` with honest denial reason, and protected `/api/control/agents/:id/approvals/{list,inspect,resolve}` POST routes. Config produces `approvalsEnabled: boolean`. Resolve consumes the exact inspected observation identity and verifies unchanged presentation.

- [x] Write failing contract/projection/config/negotiation/service/route tests using legacy fixtures as evidence, not asserted truth. Cover all spec bounds, strict fields, bidi/unicode-safe IDs, cross-target identity, invalidation, replay/event ordering, exact observer cleanup, unsupported scope/method/binding, expiry/concurrent first-answer, changed presentation, duplicate/no-replay uncertainty, rate limits and close/abort.
- [x] Run `npm test -- shared/controlApprovals.test.ts server/control/approvalService.test.ts server/control/approvalRoutes.test.ts server/control/config.test.ts server/control/gatewayClient.test.ts`; capture meaningful RED before production edits.
- [x] Implement minimal scoped boundary on current main. Reuse canonical target parsing and existing auth/transport. Native methods/scopes must match installed primary source. Keep configuration docs for Task 3. Add no generic RPC or arbitrary native response forwarding.
- [x] Rerun focused tests, `npm run typecheck`, `npm test`, `npm run build`; require pass and clean diff.
- [x] Verify GitHub CLI identity is `SweetSophia`; commit as `feat: add scoped native approval boundary`.

### Task 2: Accessible live-only approval review

**Files:** Create `src/control/useApprovals.ts`, `src/control/useApprovals.test.tsx`, `src/components/ConversationApprovals.tsx`, `.css`, `.test.tsx`, `.integration.test.tsx`; modify `src/control/api.ts`, `src/components/AgentDetailPanel.tsx` and its relevant tests. Task 1 shared interfaces are binding; do not weaken them.

**Interfaces:** Consume Task 1 capability, parsers, opaque inspected-observation identity and protected routes. Produce `useApprovals(target, active)` and `ConversationApprovals({target,active,readOnly})` integrated into the live conversation surface. Serialize only canonical target fields, never full session-row objects.

- [x] Write failing real-hook/panel tests for all lifecycle cleanup, last-known timestamp preservation, explicit setup failures, historical suppression, pending/details/terminal display, immutable target/id/kind/decision/content confirmation, expiry, replacement before passive effects, Cancel-first focus/Escape restoration, duplicate same-task clicks, native first-answer/unknown result, explicit read reconciliation and no automatic retry.
- [x] Run `npm test -- src/control/useApprovals.test.tsx src/components/ConversationApprovals.test.tsx src/components/ConversationApprovals.integration.test.tsx src/components/AgentDetailPanel.runControls.test.tsx`; capture RED.
- [x] Implement minimal UI with existing access/focus patterns; preserve run history, Stop/Steer, late-send adoption and private draft behavior. Do not expose raw policy, private channels or standing decisions.
- [x] Rerun focused tests, typecheck and full suite; require pass and clean diff; commit as `feat: review live conversation approvals`.

### Task 3: Setup documentation and release qualification

**Files:** Modify `.env.example`, `docs/configuration.md`, `docs/task-access-setup.md`, `docs/revamp-status.md`, `docs/superpowers/plans/2026-10-26-revamp-phase-two.md`; include this plan/spec in commit.

**Interfaces:** Consume accepted Tasks 1–2 behavior. Produce truthful opt-in/scope/binding/error/uncertainty guidance, release evidence and phase-two status without premature merge/deployment/publication claims.

- [x] Document separate approvals authority, explicit operator pairing, supported decisions, sanitized audience/child attribution, stale/expiry/first-answer/unknown semantics, process-local no-replay limitation and historical read-only UI.
- [x] Run `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate`, `git diff --check`, and documented Docker API/SPA startup probes. Do not weaken any gate.
- [x] Using agent-browser skill in an isolated synthetic fixture, test desktop/phone/short-window confirmation, history suppression, focus/Escape, stale/expiry/unknown/first-answer states, console/network and scoped accessibility. No real Gateway/control credentials. Inspect screenshots, close owned browser/server/container. Final `c1a3822` passed 20 hard native-browser keyboard/phone-geometry assertions plus 35 recovery, 64 latch and 112 private-state assertions. Earlier contrary traces remain preserved; owned resources are closed. These synthetic checks do not establish live approval acceptance or whole-application accessibility.
- [x] Commit as `docs: document private approval handling`; complete task and final whole-branch reviews, fixes, push/Ready PR, current-head bot validity assessment, full 15-minute window, green protections, merge and exact post-merge main CI/CodeQL under existing roadmap authorization.

## Delivery closeout

[PR #332](https://github.com/SweetSophia/openclaw-pixel-agents/pull/332) merged the independently reviewed final head `c1a3822` as `56181af2463edc4dc6272ffe8653b3eca70c9885` at 2026-10-29 23:58:19 UTC. The full review window elapsed and protected checks passed; final feedback and bot-review limits are recorded in the PR. Exact post-merge `main` [CI](https://github.com/SweetSophia/openclaw-pixel-agents/actions/runs/40976651227) and [CodeQL](https://github.com/SweetSophia/openclaw-pixel-agents/actions/runs/40976651099) passed. The merged source matches the qualified source tree; a fresh merged-tree run also passed all 1,723 tests. No live approval/task, permission change, deployment or npm publication was performed.

## Self-Review

Task 1 owns authority, native lifecycle and untrusted boundaries; Task 2 consumes that closed contract without inferring source identity; Task 3 verifies and documents only final behavior. Each Review Focus case is pinned to an owning regression. Existing legacy implementation is useful scaffolding, but its missing observation fence and attempted-operation retention require fresh failing tests, not blind reuse.
