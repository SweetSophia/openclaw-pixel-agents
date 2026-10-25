# Read-only agent Workspace panel

Status: the user selected the Workspace panel on 2026-10-25, following the proposed browsing, previews and supported downloads scope. Implementation choices and bounds below are Codex defaults within that scope.

## Intent

Make files in the selected agent's workspace discoverable from the office, including files never attached to a conversation. Reuse the office key, paired `operator.read` device and private backend Gateway adapter. This is trusted operator access to the selected agent's workspace, not a claim that files belong to the selected task or conversation.

No editing, uploads, deletion, host filesystem reads, new authentication modes, dependency changes or real agent tasks are needed. Results continues to show assistant-delivered outputs with its existing task/run association.

## Source contract and approach

Use the native optional `agents.workspace.list` and `agents.workspace.get` RPCs through the existing backend. The installed OpenClaw documentation and public protocol schemas describe these read-only methods; `agents.files.*` instead manages bootstrap files. No alternative local-path or transcript parsing fallback is appropriate for remote Gateway deployments.

- List accepts `{agentId, path?, offset?, limit?}` and returns `{agentId,path,parentPath?,entries,totalEntries,offset}`. Entries have `path,name,kind` and optional `size,updatedAtMs`; kinds are file or directory. Native ordering is directories first, then names.
- Get accepts `{agentId,path}` and returns `{agentId,file:{path,name,size,updatedAtMs,mimeType,encoding,content}}`, encoding UTF-8 text or base64 image. There is no generic binary download or write method in this namespace.
- Native text reads cap at 256 KiB; native images cap at 5 MiB. The office retains its existing 2 MiB Gateway frame budget. This first office release admits text up to 256 KiB and image files up to 1 MiB, with fresh metadata checks before content reads. Actual decoded bytes must satisfy those bounds too. A file changing beyond transport limits may make the source unavailable; no larger ordinary RPC budget is introduced.
- Gateway policy confines reads to the configured real workspace, rejects symlink/hardlink escapes and does not return the host root. The office additionally validates every relative path and verifies agent/path identity in all responses.

Evidence: installed `docs/gateway/protocol/rpc-talk-config-and-agents.md`, `dist/agents-workspace-Wm71Yllk.mjs` and public workspace schemas in `dist/src-l2dWvEsN.mjs`. Compiled modules are inspection evidence only; product code must not import them.

## User experience

Add Workspace between Results and Agent in the existing modal drawer. Retain the existing initial Task tab, keyboard tab navigation, focus trap, Escape and dismissal behavior. Five tabs wrap into readable rows with 44px targets on phones and short screens.

Workspace uses the same unlock/setup/Lock controls and connection status as the other private tabs. Extract their existing access presentation into a shared component rather than duplicating key handling. It does not show a conversation selector or require visible sessions; Task/history polling stops while Workspace is selected.

Show the agent name, a clear read-only workspace label, root/ancestor breadcrumb buttons and a paginated directory list. Start at the root. Directory buttons navigate; file rows show name, known size and modification time. Refresh reloads the same directory from its first page. Previous/Next reads 50 entries per page; entries are not accumulated into an allegedly stable directory snapshot. Explain that files may belong to any conversation and listings can change while agents work.

Load content only on explicit Preview or Download. Text previews render as React text nodes with wrapping, including HTML/SVG source. Still PNG/JPEG/WebP previews reuse the existing header/dimension checks; other supported native image formats are download-only. Downloads contain the bytes returned by the native API, use safe attachment names and never claim to export unsupported binary files. Unknown sizes, oversized files and native unsupported types have readable unavailable states. Closing a preview uses normal panel content, not another overlay.

Refresh visible directory metadata every five seconds, plus manual Refresh. Show when OpenClaw last checked it. On a failed same-directory refresh, keep last-known metadata with its original time and disable content actions. Initial failure, empty directory, missing path, unsupported method and unavailable connection have distinct states. Refresh or navigate back when a file/directory disappears; never switch agents or conversations silently.

## Private API and ownership

Add validated shared workspace DTOs in `shared/controlWorkspace.ts`, plus dedicated server service and frontend hook/component. Existing public sockets, `AgentState`, collector, preferences and layouts remain independent.

1. `POST /api/control/agents/:id/workspace`: validated `{path,offset}`; returns one normalized page, agent identity, current path, count, source observation and opaque connection revision.
2. `POST /api/control/agents/:id/workspace/file`: validated `{path,offset,sourceRevision,expected:{size,updatedAtMs},intent}`; intent is preview or download. The service freshly lists the selected parent page, verifies that the exact file still has the selected metadata, applies type/size policy, and only then reads it. Verify returned agent, path, metadata and actual byte length before sending content.

All routes sit behind existing transport, origin, key, read-budget and `Cache-Control: no-store` protection. Content requests share the existing two-concurrent/six-per-minute-per-IP file budget. RPCs are optional allowlisted capabilities; older Gateways still support Task/Conversation/Results and Workspace explains unavailability.

Validate registered agent membership before and after every awaited RPC. Paths are canonical workspace-relative strings: empty only for root, no absolute/drive/UNC paths, backslashes, empty/dot/traversal segments or control characters; at most 2,048 characters. Reject extra request fields and oversized/malformed replies. Validate list children against the exact parent, and returned page agent/path/offset against the request; never project an upstream host-root field into the response. Page size 50; maximum navigable offset 10,000 with an explicit limit state. Normalized metadata stays within 256 KiB.

Scope pages and content to a connection revision that changes on Gateway invalidation/reconnect and agent/configuration invalidation events. A stale revision, metadata mismatch, removed agent or lost authority refuses content. No workspace file metadata/content is cached on disk or broadcast. No preview bytes enter browser storage or logs.

Close, Lock, hidden page, agent/tab/directory changes, connection revision changes and observed selected-file metadata changes abort pending reads, clear previews and revoke owned Blob URLs. Late results cannot replace a new selection or trigger an unwanted download. Re-entering a visible Workspace refreshes its metadata. Already exported downloads remain ordinary user files.

## Verification and delivery

Use meaningful failing regressions for path/body/reply validation, optional negotiation and old Gateway compatibility, registered ownership, parent/child matching, pagination, preflight bounds and changed-file/connection races. Exercise the real adapter/service/router using a controlled Gateway fixture. Prove no workspace calls occur while locked and no filesystem or write RPC fallback is attempted.

Frontend tests cover root/ancestor/page navigation, empty/unsupported/stale states, explicit content actions, unknown/oversized sizes, lock/hidden/tab/agent/directory cleanup and out-of-order replies. Existing private access and Task/Conversation/Results tests must remain green. Native browser checks cover desktop, phone and short windows, five-tab keyboard navigation, wrapping/touch targets, text/image preview, downloads and modal cleanup.

Verify at least a native workspace list/text read against isolated synthetic Gateway state or a permitted read-only fixture before claiming integration. Send no real agent task. Run typecheck, tests/coverage, build, package smoke, both dependency audits, independent review and current-head bot-comment inspection. Follow standing merge/deployment authorization, preserve live state and keep retired previews disabled. Publishing a new npm version is a separate release action.

## Builder choices

The builder may choose internal names, attachment response reuse and detailed visual spacing. A narrow extraction of the existing shared unlock/connection presentation is permitted. Do not expand this scope into file editing, a generic RPC proxy, an arbitrary host browser or new Gateway permissions.
