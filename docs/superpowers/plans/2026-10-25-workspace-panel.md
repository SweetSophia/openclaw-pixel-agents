# Workspace Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browse the selected agent's workspace, preview bounded text/images and download supported native files from the office.

**Architecture:** Optional native Gateway workspace reads feed a dedicated validated private service and two authenticated routes. An agent-level Workspace tab reuses the existing private access presentation and file response policy while owning its directory/preview lifecycle independently of task conversations.

**Tech Stack:** Existing TypeScript, React, Express, Socket.IO and Vitest; Node 22.22.2+/24.15.0+/26+; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-workspace-panel-design.md`

## Global Constraints

- Read-only `agents.workspace.list/get`, existing office key and `operator.read`; no filesystem fallback, write RPC, public data or real agent task.
- Canonical relative paths <=2,048 characters; 50 entries/page; offset <=10,000; metadata <=256 KiB.
- Native text <=256 KiB and images <=1 MiB; preserve the existing 2 MiB Gateway frame cap. Fresh parent-page preflight and actual-byte checks are mandatory.
- Use exact agent/path/page identity, expected size/mtime and opaque connection revision; abort/clear on access, tab, agent, directory, visibility and observed file/source changes.
- Preserve unrelated user files, live keys/device grants/layouts/preferences and retired preview services.

## Review Focus

- An empty conversation list must not hide an otherwise browsable agent workspace; no task/history reads on Workspace.
- A file moving between native offset pages or disappearing while read must produce Refresh guidance, never unrelated bytes.
- A reconnect with identical agent/path must clear existing previews even if the source quickly returns to ready.
- Unusual Unicode names and zero-byte files must remain usable without creating unsafe attachment headers or paths.
- A previously selected image that changes during periodic directory refresh must lose its preview and download authority.

---

### Task 1: bounded native workspace reads and protected routes

**Files:** Create `shared/controlWorkspace.ts`, its test, `server/control/workspaceService.ts`, its test and `workspaceIntegration.test.ts`; modify `shared/control.ts`, `server/control/gatewayClient.ts`, `routes.ts`, `server/index.ts` and existing Gateway/route tests.

**Interfaces:** Export `WorkspaceEntry`, `WorkspacePage`, `WorkspaceListRequest`, `WorkspaceFileRequest`, `WORKSPACE_LIMITS`, `isWorkspacePath`, `parseWorkspaceListRequest`, `parseWorkspaceFileRequest`, `parseWorkspacePage`, and `workspaceFileLimit`. Page includes `agentId,path,offset,totalEntries,entries,source,sourceRevision`; file request includes `path,offset,sourceRevision,expected:{size,updatedAtMs},intent`. `createWorkspaceService(gateway, registeredAgentIds): WorkspaceService` exposes `list(agentId,input,signal?)`, `file(agentId,input,signal?)` and `close()`. File returns the existing bytes variant of `ArtifactContent` for the existing attachment writer. Router option is optional `workspace?: WorkspaceService`; production constructs/disposes it alongside artifacts.

- [ ] Write failing contract tests for paths, closed bodies, root/Unicode/empty-file metadata and reply page identity/size; service tests for metadata-only listing, preflight before get, missing/oversized/unknown-size refusal, source/agent/metadata changes and byte/MIME validation.
- [ ] Run `npm test -- shared/controlWorkspace.test.ts server/control/workspaceService.test.ts`; expected FAIL because workspace behavior is absent.
- [ ] Implement parsers and native normalization. Permit only optional workspace methods in the Gateway client, preserve base handshake requirements, and normalize native workspace error detail types. Add `workspace-changed` error code without changing existing task errors.
- [ ] Add routes behind current access/mutation guards and shared content budget. Reuse existing file response writer and preview policy; wire the service in server construction and shutdown.
- [ ] Exercise real Gateway framing/service/router with a controlled fixture, including auth, older Gateway compatibility, exact RPC params, no history/send/fallback calls, cancellation and stale revision rejection. Run `npm test -- shared/controlWorkspace.test.ts server/control/workspaceService.test.ts server/control/workspaceIntegration.test.ts server/control/gatewayClient.test.ts server/control/routes.test.ts`; expected PASS.
- [ ] Commit the backend slice.

### Task 2: accessible agent-level browsing and private preview lifecycle

**Files:** Create `src/components/ControlAccessPanel.tsx`, `AgentWorkspace.tsx`, `AgentWorkspace.css`, `src/control/useWorkspace.ts` and meaningful hook/component tests. Modify `TaskDetails.tsx`, `AgentDetailPanel.tsx`, its CSS/tests, and `src/control/api.ts` for workspace failure copy.

**Interfaces:** Shared access component takes `{active,loading,onRefresh,children}` and preserves existing setup/unlock/Lock/status behavior. `useWorkspace({agentId,active})` returns `page,path,offset,loading,error,preview,contentLoading,navigate(path,offset?),refresh(),act(entry,intent),clearPreview()`. Preview discriminates text/image and owns object URLs. `AgentWorkspace({agentId,active})` owns this hook and shared access component; no TaskDetailsState shim or conversation selector.

- [ ] Write failing hook/UI tests for root/ancestor/pages, zero sessions, preserved path on refresh, explicit content actions, empty/stale/unsupported errors, Unicode names and empty files. Include out-of-order reads, file metadata changes, source revision changes and teardown on hidden/lock/tab/agent/navigation.
- [ ] Run `npm test -- src/control/useWorkspace.test.tsx src/components/AgentWorkspace.test.tsx`; expected FAIL for missing workspace UI.
- [ ] Extract only existing access/status presentation, keeping key ownership in ControlAccessProvider. Reuse it from TaskDetails and Workspace. Preserve visible controls and Task behavior.
- [ ] Implement five-second visible directory refresh with one request in flight, exact response identity checks and original stale timestamps. Admit content only from the current page/revision; use shared file API/header handling, safe preview MIME validation and revocable explicit-download Blob URLs. Clear late file/preview work on all spec transitions.
- [ ] Add Workspace before Agent in the tab list and stop task/session polling there. Wrap tabs at readable sizes; use existing modal/focus behavior and 44px actions. Render text safely and use native directory/page buttons rather than a new tree widget or overlay.
- [ ] Run workspace UI/hook and existing private access/task/results/conversation/panel tests; expected PASS. Commit UI slice.

### Task 3: native/browser qualification, documentation and independent review

**Files:** Update `README.md`, `docs/task-access-setup.md`, relevant plan status and focused tests only if qualification identifies a real defect. Store synthetic qualification artifacts in this plan's ignored workspace.

**Interfaces:** Reuse shipped setup and runtime-only rollback conventions. No new key/grant, dependency, package version or npm publication.

- [ ] Verify one native list/text read with an isolated synthetic Gateway or permitted fixture; no real task or agent workspace mutation. Record the actually verified contract and limitations.
- [ ] Run native browser checks for desktop/phone/short viewport, keyboard tabs and modal restoration, empty/current/stale/unsupported states, text/image/download actions and cleanup. Use a controlled fixture to avoid exposing live private filenames/content in screenshots.
- [ ] Document that Workspace is agent-wide, read-only, native-limited and independent of conversation selection; explain bounds and old Gateway behavior.
- [ ] Run `npm run typecheck`, `npm run test:coverage`, `npm run build`, `npm run test:package`, `npm audit --omit=dev --audit-level=high`, `npm audit --audit-level=moderate`; expected all PASS and zero vulnerabilities.
- [ ] Commit final evidence/docs, then request one fresh whole-branch review against this plan/spec and inspect current-head bot comments. Address valid findings with targeted regressions before merging under standing authorization.
- [ ] Deploy through the existing backup/runtime-only path only after checks/review pass; preserve state and collector, keep retired previews disabled and verify fresh roster/private read availability. No new npm publication without release authorization.
