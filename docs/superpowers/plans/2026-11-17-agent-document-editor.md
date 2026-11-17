# Agent Document Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an independently configured, default-off editor for four existing agent documents, without changing live authority or files.

**Architecture:** A third profile in the existing signed Gateway client owns a separate document identity and closed native method set. Focused shared validation and private service/routes issue epoch-bound, one-use revisions; a small Workspace child owns draft lifecycle and explicit saves.

**Tech Stack:** Existing TypeScript, React, Express, Vitest, Node and browser tooling; no new dependency.

**Spec:** `docs/superpowers/specs/2026-11-17-agent-document-editor-design.md`

## Global Constraints

- Source/synthetic work only: no live credentials, pairing, grants, file writes, deployment, service restart or npm publication.
- Preserve Node `^22.22.2 || ^24.15.0 || >=26.0.0`, ordinary/scheduling identities, existing signed protocol-4/HTTP/Origin/transport guards and all private/public boundaries. No new dependency.
- Opt-in `CONTROL_DOCUMENTS_EDIT_ENABLED=true`; bootstrap only `OPENCLAW_DOCUMENTS_GATEWAY_TOKEN` or `OPENCLAW_DOCUMENTS_GATEWAY_PASSWORD`; private identity at `DATA_DIR/control-documents`. Disabled creates nothing; configured connection starts only on authenticated explicit document-editor opening.
- Local RPC allowlist exactly `agents.files.get` and `agents.files.set`; separate native `operator.read`/`operator.admin` grant. Never call a generic tool, shell, file fallback or reuse/elevate an existing grant. Local allowlisting is not a cryptographic restriction of admin.
- Names exactly `AGENTS.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, case-sensitive/root-only/existing-only. Strict UTF-8 at most 32 KiB; empty is valid; no NUL, non-tab/newline/carriage-return ASCII controls or unpaired surrogates. Preserve global JSON body limit 100kb.
- Require exact native agent/name/workspace/hash and round-tripped bytes; native `expectedHash` and `expectedWorkspace` are mandatory for office saves. Never claim external-writer atomic CAS.
- Server revisions/operations are bounded to 32/128 records and 10 minutes; no private content journal, automatic mutation retry, force overwrite or old-ticket replay after restart.
- Drafts stay private in tab memory. Preserve typed text on conflict/uncertainty, invalidate stale save authority, require explicit current-file review; Lock/credential/agent/final-close clears. Hidden page cancels reads and invalidates save authority without dropping the draft. Dirty navigation/close/reload requires discard consent.

## Review Focus

- Native text can be lossy-decoded while its hash names original bytes: mismatching re-encoding must never become an editable snapshot (Task 1).
- Two tabs or lost replies must never dispatch the same operation twice, silently overwrite a newer revision or regain an old ticket after reconnect/restart (Task 1).
- Existing ordinary device grants and model-selection behavior must not inherit admin through a third profile; default-off startup must create no identity (Task 1).
- A late save/read, Lock, hidden page or document/agent change must not replace typed text or publish private data into another owner (Task 2).
- Real modal Escape/tab/overlay close and short/phone layouts must protect dirty drafts without trapping textarea keys or breaking existing Workspace browsing (Tasks 2 and 3).

---

### Task 1: validated private document boundary and signed profile

**Files:** Create `shared/controlAgentDocuments.ts`, `shared/controlAgentDocuments.test.ts`, `server/control/agentDocumentConfig.ts`, its test, `agentDocumentService.ts`, its test, `agentDocumentRoutes.ts` and `agentDocumentIntegration.test.ts`. Modify `server/control/gatewayClient.ts`, `gatewayClient.test.ts`, `routes.ts`, `shared/control.ts`, `server/index.ts` and directly affected existing tests.

**Interfaces:** Shared exports `AGENT_DOCUMENT_NAMES`, `AGENT_DOCUMENT_LIMITS`, `AgentDocumentName`, `AgentDocumentManagement`, `AgentDocumentSnapshot`, `AgentDocumentReadRequest`, `AgentDocumentSaveRequest`, `AgentDocumentSaveReceipt` plus `parseAgentDocumentReadRequest`, `parseAgentDocumentSaveRequest`, `parseAgentDocumentManagement`, `parseAgentDocumentSnapshot`, `parseAgentDocumentSaveReceipt`, and `isAgentDocumentText`. Management follows scheduling's `{configured,state,canEdit,epoch,reason}` shape. Snapshot is `{agentId,name,revision,content,bytes,source}`; save input `{name,revision,operationId,content}`; receipt `{agentId,name,operationId,state:'saved'|'conflict'|'unknown',snapshot?}` with snapshot only on saved. All parsers use closed bounded bodies.

`loadAgentDocumentConfig(env,dataDir,control): AgentDocumentConfig`; `createAgentDocumentGateway(config): AgentDocumentGateway` with `start`, `close`, `onEvent`, `status`, `connection`, `request`. Connection is `{epoch,gatewayUrl,deviceId}|null`; request methods only the two document RPCs. `createAgentDocumentService(gateway,registeredAgentIds): AgentDocumentService` exposes `status(agentId)`, `read(agentId,input,signal?)`, `save(agentId,input,signal?)`, `close()`. Private router mounts GET `/status`, POST `/read`, POST `/save` beneath `/api/control/agents/:id/documents`; parent router supplies existing access checks and must preserve exact agent params. Error codes may add `document-denied`, `document-changed`, `document-outcome-unknown` consistently to server/shared/client contract.

- [ ] Write failing parser/config tests proving closed names/bounds/UTF-8/empty input, immutable operation/revision shapes, disabled credentials create no authority and no ordinary credential borrowing. Run `npm test -- shared/controlAgentDocuments.test.ts server/control/agentDocumentConfig.test.ts`; capture expected missing-behavior failure.
- [ ] Implement those shared/config contracts and signed Gateway document profile. Add protocol tests for separate requested/retained scopes, optional ordinary compatibility, lazy disabled behavior, exact RPC allowlist, unsupported methods, per-profile error mapping and post-dispatch uncertainty. Run focused tests; expect PASS.
- [ ] Write failing real-service tests for native raw-byte hash mismatch, missing/oversized/disallowed files, mandatory stored preconditions, changed workspace/source, concurrent same-operation requests, immutable operation reuse, capacity/expiry, consumed revision, pre/post-dispatch abort and malformed acknowledgement. Fixtures must assert resulting receipts/state and actual transport frames, not just mock presence.
- [ ] Implement bounded one-use revisions and operation receipts; verify response identity and acknowledge exact submitted bytes. Consume before dispatch and fence source changes. Add authenticated real router/protocol integration, including default-off startup with no document directory, auth/Origin regression and no ordinary/scheduling/send RPC.
- [ ] Run `npm test -- shared/controlAgentDocuments.test.ts server/control/agentDocumentConfig.test.ts server/control/agentDocumentService.test.ts server/control/agentDocumentIntegration.test.ts server/control/gatewayClient.test.ts server/control/routes.test.ts`, `npm run typecheck`, then `npm test`. Self-review and commit this backend slice; record RED/GREEN and limits.

### Task 2: explicit document editing and retained private drafts

**Files:** Create `src/control/useAgentDocuments.ts`, its test, `src/components/AgentDocuments.tsx`, `AgentDocuments.css` and component tests. Modify `src/components/AgentWorkspace.tsx`, its tests, `AgentDetailPanel.tsx`, its tests and `src/control/api.ts` as necessary for the new errors. Do not alter canvas/game code.

**Interfaces:** Consume Task 1 shared types/parsers/routes. `useAgentDocuments({agentId,active,opened})` owns management, selected name, snapshot, draft, loading/saving/error/receipt/dirty and explicit `select`, `setDraft`, `reload`, `save`, `reset` actions; final exact hook return may be shaped cohesively within this module and component. `AgentDocuments({agentId,active,onDirtyChange?})` is an explicit expandable child in Workspace. Add optional `onDocumentDirtyChange` to `AgentWorkspace` and wire the real parent modal's dirty-navigation/close guard. Keep existing props backwards-compatible.

- [ ] Write failing hook tests for explicit-opening only, default-off/pairing/unsupported states, fresh selected document read, strict response identity/UTF-8/size, dirty validation and one Save with `newEntityId()`. Run `npm test -- src/control/useAgentDocuments.test.tsx`; expect missing behavior FAIL.
- [ ] Implement bounded reads and explicit saves. Keep immutable submission identity and prevent late replies from replacing a newer draft/owner. Conflict or uncertain results retain text but invalidate Save; reload/review requires discard consent and never silently rebases. Hidden/unavailable source retains draft but invalidates revision; Lock/credential/agent/unmount clears private state. Bound client deadlines and reject any stale/invalid management epoch.
- [ ] Write failing component/real-parent tests for dirty document/tab/overlay/Escape close and reload cancellation, unchanged read-only Workspace browsing, byte count, empty files, valid textarea keyboard behavior, no public/storage use and clear disabled guidance. Implement using normal-flow markup, labeled textarea, visible target and 44px actions; native confirm is sufficient, beforeunload warns while dirty.
- [ ] Run focused document/Workspace/AgentDetailPanel/private-access/model/scheduling UI tests, `npm run typecheck`, then `npm test`. Self-review and commit the UI slice, recording RED/GREEN and limitations.

### Task 3: qualification and operator documentation

**Files:** Create `docs/agent-documents.md`; update `.env.example`, `README.md`, `docs/configuration.md`, `docs/task-access-setup.md`, `docs/revamp-status.md`, `package.json` package-file allowlist, this plan/spec and targeted qualification regressions only when a defect is evidenced. Qualification support/evidence belongs in this plan's ignored SDD workspace, not product-only test seams.

**Interfaces:** Use shipped shared contracts, signed Gateway/service/routes and the real parent UI. Synthetic server/native-shaped transport/browser fixtures may use only owned temp files and fixture keys; no installed/live credentials, pairing, Gateway restart or real document writes. Externally installed native source may be read/validators exercised, not modified.

- [ ] Add focused docs/packaging regressions for included guide and existing installed startup/default-off behavior, not prose-only change detectors. Run relevant package tests and verify production startup creates no document identity by default.
- [ ] Exercise compiled synthetic get/save/conflict/unknown and reconnect against the actual HTTP boundary; verify immutable native expectedHash/expectedWorkspace, one dispatch, no private bytes in public agents/socket, no unsafe fallback. Where feasible run the real installed native handler against a wholly synthetic confined fixture; distinguish this from live permission acceptance.
- [ ] Use isolated real Chromium with the actual parent modal and synthetic documents to check desktop/phone/short viewport, text input/undo/Space/arrow containment, explicit Save, dirty cancel/discard, conflict/uncertainty retention, Lock cleanup, focus, no console exceptions and screenshots actually inspected. Do not enter the live office key or browse live private files.
- [ ] Document separate default-off admin opt-in/device/revocation, broad-credential risk, exact four names and 32 KiB bound, optimistic-check/external-writer limit, draft-clearing rules, no-replay/unsupported guidance and source-vs-live distinctions. Reconcile tracker only for this slice, leaving uploads/general editing pending; no release/version bump.
- [ ] Run `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate` and exact-source Docker startup when available. Record commands/results/limits; self-review and commit final qualification/docs.

## Execution authorization and handoff

Standing roadmap authority covers source implementation/review without routine task-by-task questions; the user explicitly delegated this recommendation. Execute source-only through task reviews and a fresh whole-branch review. Actual grant/pairing/activation, deployment and live file mutation are not authorized by this plan. Follow the repository's exact-head checks and 15-minute reviewer window for any Ready PR push; never bypass protections or call incomplete source work a live feature.
