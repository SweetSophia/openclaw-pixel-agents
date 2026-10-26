# Conversation Usage Implementation Plan

Status (2026-10-26): source implementation, review and qualification merged in [PR #323](https://github.com/SweetSophia/openclaw-pixel-agents/pull/323) as `cf1dceb`. All nineteen posted review threads were assessed and resolved; final required CI, Docker and 1,407 local tests passed. This PR did not deploy or publish. See [revamp status](../../revamp-status.md) for pending rollout qualification.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add source-backed, read-only Usage for the selected conversation.
**Architecture:** Optional native Gateway RPC, a private normalized service/route, and an additional mode in the existing selection/polling hook. No parallel private store or public snapshot changes.
**Tech Stack:** Existing TypeScript, Express, React, Vitest, native WebSocket; no dependencies.
**Spec:** docs/superpowers/specs/2026-10-26-usage-panel-design.md

## Global Constraints

- Keep exact ControlTarget ownership, identity, tab-memory key and operator.read transport boundaries.
- Query one session instance over retained history; never show family/global/run totals as this conversation.
- Missing metrics remain unknown, explicit zero stays zero, context occupied remains unavailable without an explicit measurement.
- No real task, private state/configuration change, dependency upgrade or npm publication.

## Review Focus

- A reset/reconnect during RPC must not return usage for the previous instance (Task 1).
- A cached/partial result must retain computation time and missing-price warnings (Tasks 1, 2).
- Older Gateways without usage support must retain Task/Conversation/Results/Workspace (Task 1).
- Switching to Usage must preserve selection and stop transcript reads (Task 2).
- Lock/hidden/close/agent/target changes must suppress late private replies and misleading zeros (Tasks 2, 3).

### Task 1: private source contract and integration

**Files:** shared/controlUsage.ts and tests; server/control/usageService.ts and tests; gatewayClient.ts/tests; routes.ts/tests; server/index.ts; controlled usageIntegration.test.ts.
**Interfaces:** `ControlUsageSnapshot` contains target, source, state (ready/partial/loading/unsupported/unavailable), optional model/contextLimit/computedAt, token metrics and cost summary. `createUsageService(gateway,tasks)` produces `{read(target,signal?),close()}`. Existing TaskService.verifyTarget supplies canonical ownership; optional sessions.usage joins the Gateway allowlist.

- [x] Write failing validator/service tests for missing/zero/invalid metrics, partial pricing and computation dates, wrong key/owner/instance, family scope, identity change during read and source cancellation.
- [x] Run focused tests and observe the missing implementation failures.
- [x] Implement bounded DTO projection and service, optional negotiation, authenticated POST route and server disposal.
- [x] Exercise real WebSocket handshake/RPC/service/HTTP protection in a controlled fixture, including an older method list and changed session.
- [x] Run focused tests/typecheck and commit the verified backend slice.

### Task 2: Usage tab and existing selection lifecycle

**Files:** src/control/useTaskDetails.ts/tests; src/components/ConversationUsage.tsx/tests; AgentDetailPanel.tsx/css/tests.
**Interfaces:** extend TaskDetailsState with `usage: ControlUsageSnapshot|null` and hook option `usageActive?:boolean`. Component receives existing state and active; no extra poller or credentials.

- [x] Add failing regressions for Usage routing without task/history RPCs, shared selection, zero/missing/partial values, stale retention, auth clearing and cancellation/late replies.
- [x] Implement Usage mode, semantic metric cards, six-tab navigation, manual refresh and responsive wrapping.
- [x] Run focused tests and typecheck; commit the verified UI slice.

### Task 3: qualification and review

**Files:** README.md; docs/task-access-setup.md; native-browser synthetic fixture/evidence in this plan's ignored workspace.

- [x] Run full types, tests/coverage, build, actual tarball smoke, Docker build/startup and both audits; record actual results.
- [x] Inspect synthetic desktop/mobile/short viewport, keyboard tabs and lock/hidden cleanup in a native browser; no real agent tasks.
- [x] Document Usage scope and unavailable context/pricing without claiming availability in already published npm 1.6.0; preserve screenshots and user README edits.
- [x] Request one fresh whole-branch reviewer; assess findings and verify material fixes with regressions.
- [x] Inspect follow-up bot comments and current-head CI before merge under standing authorization. No npm publish. Completed for PR #323; Kilo's last run hit its provider rate limit, and merge proceeded under the user's then-current waiver after valid findings were fixed and required checks passed.
