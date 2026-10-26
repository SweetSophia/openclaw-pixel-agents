# Task results and delivered files

Status (2026-10-26): user-approved on 2026-10-24 and complete in PR #304, after portable operator key setup in PR #299. Recorded live acceptance and the subsequent 1.5.0 release are linked from [revamp status](../../revamp-status.md); new rollout qualification remains separate.

## Intent and selected scope

Make an agent's response and the files it shared easy to find from the existing agent-detail panel. Reuse the selected conversation and existing task unlock. The first release covers assistant-delivered outputs, not every file that an agent has created or edited on disk.

The user selected this release before a workspace browser. Workspace browsing, uploads, editing, historical run selection, approvals and run controls remain separate follow-ups. Downloading a file never sends a message, starts a task, or delivers anything to an external channel.

## Findings behind the proposal

- The existing panel has Task, Conversation and Agent tabs. `useTaskDetails` owns the selected conversation; `ControlTaskSnapshot.result` is present only when recorded facts correlate an assistant response with a completed run. `latestResponse` can exist without that completion proof.
- The installed OpenClaw 2026.10.3 package documents `artifacts.list`, `artifacts.get` and `artifacts.download`, all requiring `operator.read`. They select an explicit session or run and accept `messageRole: "assistant"` to exclude uploaded inputs and raw tool observations. A run ID alone does not establish that an artifact was delivered by the assistant.
- A live, read-only query accepted that assistant filter. The sampled conversation returned zero delivered artifacts. This verifies discovery and its empty case, not a successful file transfer; transfer proof is still a delivery gate.
- Artifact summaries contain identity, type, display title, optional MIME/size/run/message sequence, and a download mode. Lists do not need to carry file bytes. General artifact listings do not support native pagination; only the separate image-discovery query supports a cursor.
- Inline downloads can use base64 over the existing connection or a short-lived, connection-bound HTTP grant. Managed media also provides artifact-scoped download tickets. Gateway-relative URLs are not directly usable from a phone when the Gateway listens on the office server's loopback interface.
- `agents.files.*` manages bootstrap files; `agents.workspace.*` is the separate workspace-browser interface. Neither is the selected release's discovery source.

Evidence: installed package docs `gateway/protocol/rpc-talk-config-and-agents.md` (Agent and workspace helpers), `gateway/operator-scopes.md` and `gateway/clients.md` (artifact downloads), checked against the installed protocol schemas and artifact handlers. Integrate through the public RPC contract; do not import compiled OpenClaw modules.

## Approaches

| Approach | What it provides | Decision |
| --- | --- | --- |
| Native artifact RPCs through the existing office backend | Source-owned provenance, assistant-only discovery, scope checks and downloads; preserves the office's existing access model. | Proposed implementation for the user's selected task-output release. |
| Parse file paths and links from raw transcripts ourselves | Can guess references in ordinary text, but duplicates Gateway policy and cannot establish safe download authority or generated-output provenance. | Rejected. |
| Browse the agent workspace | Finds files that were never attached to a conversation, with different scope and navigation needs. | User deferred this to a later release. |

## User experience

### Entry and layout

- Add a **Results** tab to the existing panel: Task, Conversation, Results, Agent. The conversation selector remains shared across tabs; opening Results never silently selects another agent or conversation.
- Keep Task as the initial tab. Results is reachable from any agent card, office character or activity entry through the same detail panel.
- Reuse the existing unlock, Lock, Refresh, stale-source presentation and modal focus behavior. No additional access key or browser connection to the Gateway is introduced.
- At narrow widths, allow the four tab controls to use two rows rather than clipping labels or reducing touch targets. Keep one scrolling content area, wrapping filenames and at least 44px action targets. Arrow/Home/End navigation derives from the actual tab list.

### Response area

- Show **Result** when the existing verified task snapshot supplies a correlated completed result.
- Otherwise show **Latest response**, explicitly saying completion is not confirmed. Failed/stopped/running/unknown work is never relabelled successful because text or a file exists. Show an authored empty state if there is no visible response.
- Render response text safely as text, retaining line breaks. Markdown rendering is not required for this release.
- Offer **Copy text** for the displayed response. If clipboard access is unavailable or rejected on the direct-IP HTTP route, provide selectable text and visible manual-copy instructions.
- Preserve existing text limits and shortened-text notices. Copy copies the displayed text; it must not imply a complete export when the response was shortened.

### Files area and association

- Use the server-verified task run ID when one exists, and send `messageRole: "assistant"` on every list/get/download request. The scope label is **Files shared for this task**.
- If the source cannot identify the task run, show **Files shared in this conversation** with a note that those files may belong to earlier work. Do not guess run ownership from timestamps or message proximity.
- This follows the same live-or-latest task as the Task tab. There is no historical run picker. If that task changes, discard the prior file selection/preview and load the new scope with a polite update, without moving keyboard focus unnecessarily.
- Display bounded title/filename, kind, MIME and size where known. Missing size is **Size unknown**, not zero. Files available while a task is running are shared outputs so far, not proof of completion.
- Empty, unsupported discovery, unavailable source, a shortened list and a file no longer available have distinct messages. Discovery that is empty must not claim no files exist anywhere in the agent's workspace.
- Offer **Preview** for bounded UTF-8 text and supported raster images, **Download** for transferable files, and an explicit external **Open link** when the source supplies an external HTTP(S) reference. Unsupported/local references remain visible with an unavailable explanation; the office does not read arbitrary host paths to make them downloadable.

### Content actions

- Load file bytes only after an explicit Preview or Download action. Discovery never loads remote image URLs or file contents automatically.
- Text previews are plain text, including Markdown, JSON and code. HTML, SVG, PDF, archives, executables, audio and video are download-only in this release; no active document is embedded in the office.
- Raster preview formats are PNG, JPEG and WebP. Bound both source bytes and image dimensions before display; reject malformed or excessive dimensions with a readable download fallback. Reuse a Gateway thumbnail when its documented route provides one, but verify the actual returned MIME and dimensions because thumbnail requests can return original bytes.
- Downloads use a safe filename and attachment response. A display title or MIME declaration cannot introduce headers or execute content.
- External references show the destination host and open only on an explicit user action, with no opener/referrer or office/Gateway credentials. Do not fetch arbitrary external URLs on the office server. Unsafe schemes and embedded URL credentials are rejected.

## Ownership and backend boundary

### Existing owners

- The collector and public agent store remain the roster owners. Results are private, on-demand reads and never enter `AgentState`, public sockets, saved layouts or preferences.
- `TaskService` remains the owner of canonical target verification and task/run association. A dedicated artifact service consumes its verified target and scope, then projects the Gateway's artifact contract into bounded office responses.
- The existing paired Gateway client remains the connection/authentication owner. Add artifact methods to an optional read allowlist; do not make them prerequisites for ordinary task/conversation access or request broader scopes.
- Detect rejected assistant filtering as unsupported. Never retry by removing `messageRole`, omitting ownership filters or switching to filesystem access.

### Proposed private API

All routes remain under the authenticated `/api/control` router with the existing transport, origin and read-budget guards and `Cache-Control: no-store`.

1. `POST /api/control/agents/:id/results`: accepts a validated `ControlTarget`; returns verified response information, the explicit run/conversation scope, freshness and normalized artifact summaries. File availability is separate from task-text availability, so an unsupported artifact method can leave the response text usable.
2. `POST /api/control/agents/:id/results/file`: accepts the validated target, the displayed scope and artifact ID, plus the closed intent `preview` or `download`. It verifies that the scope is still the one selected by the server before resolving the artifact. Returns private bounded content or a normalized external-link descriptor. Never accepts an arbitrary path, URL, RPC method or Gateway address.

Use new validated shared types for the normalized scope, artifact summary and content outcome. Internal names and splitting the second endpoint into distinct binary/JSON handlers are builder choices. Conversation identifiers stay out of route URLs.

Before and after awaited artifact work, revalidate the agent, canonical session ID, lifecycle/branch and selected task scope. A reset/recreation, branch change, access failure or new selected run invalidates pending reads; late responses cannot replace the new panel. Artifact IDs are selectors, not independent permission. Get/download retain the same assistant/run filters as discovery, and the returned artifact must match the requested selection.

### Transfer ownership

- Prefer `artifacts.download` with a connection-bound HTTP grant for inline files when the office backend can reach the configured Gateway's HTTP route. Proxy bytes through the authenticated office endpoint; never give the phone a loopback URL or a Gateway ticket.
- Derive the permitted HTTP origin from the configured Gateway connection, and allow only the documented artifact-download or managed-outgoing-media route shapes returned for the selected artifact. Reject unrelated paths, origin changes, redirects, URL credentials and path-escape encodings. The browser cannot supply the upstream URL.
- A failed/unsupported HTTP route may fall back once to inline transfer while preserving all scope/role filters and the existing WebSocket frame budget. A file that exceeds that budget remains explicitly unavailable through that fallback; do not enlarge ordinary RPC limits or change the Gateway deployment to make it work.
- Recheck target/scope after the bounded transfer and before exposing its bytes. Keep tickets server-side and ephemeral; disconnection/expiry requires resolving a fresh grant rather than replaying an old URL against a new connection. Never send the office access key to the Gateway or attach Gateway credentials to an external URL.

## Bounds and lifecycle — proposed Codex defaults

These values are proposals rather than additional user requirements:

| Resource | First-release bound |
| --- | --- |
| Normalized metadata response | Existing 256 KiB response limit |
| Retained artifact summaries | Up to 100, newest by available source sequence with stable ties; label a shortened collection |
| Text preview | 256 KiB, UTF-8 only, with an explicit shortened/unsupported state |
| File transfer | 16 MiB actual bytes; enforce the cap even when declared size is absent/wrong |
| Raster preview | At most 8 MiB source and 16 million pixels; inspect format/dimensions before display |
| Content work | At most two concurrent transfers and six content requests/minute per client IP, separately from sends and metadata reads |
| HTTP content deadline | 30 seconds total, abort on panel close, Lock, hidden page or selection/connection invalidation |
| Artifact metadata cache | At most 32 selections, 60-second expiry, at most two seconds of successful read reuse |

General artifact listing has no native cursor. Within the existing Gateway wire limit, normalize at most 100 summaries and clearly expose truncation; do not invent a cursor or claim complete discovery. Existing handling of malformed/oversized Gateway frames remains a source failure. An optional artifact RPC error is a Results feature error, not a reason to renegotiate ordinary task methods.

Refresh visible results metadata every five seconds while the tab and document are visible, plus manual Refresh. Coalesce shared reads and reuse the selected task snapshot; do not add a second independent task/history discovery loop. A failed same-scope refresh keeps the previous response/list with its original timestamp and stale label. Disable content actions until access and scope are current again.

Close, Lock, credential changes and selection/connection invalidation abort content work, clear preview bytes and revoke owned Blob URLs. Preview text/binary data and temporary grants are not persisted, logged or broadcast. Metadata caches are invalidated by the same source lifecycle events as task facts. Already exported user downloads are ordinary saved files, not revocable previews.

## Verification and delivery gates

- Add meaningful failing regressions for the actual boundaries: assistant-only scope on list/get/download, task versus conversation association, ownership mismatches, reset/branch/new-run races, late responses, locked/unsupported/empty/stale cases and limits.
- Exercise real service/route/client paths with a controlled Gateway fixture covering inline bytes, same-Gateway grants, managed media, external references, expired grants, connection loss, oversized/misdeclared content and failed transfers. A fake local file path must never cause a host-file read.
- Verify the installed Gateway's advertised artifact methods/filtering and at least one real successful native transfer contract before claiming complete integration. Use a known permissible existing output, or an isolated synthetic Gateway/session if there is no suitable real artifact; never send a real agent task merely to manufacture test data.
- Native browser checks cover desktop, phone and short windows, all four tabs and keyboard/focus restoration, preview/download, direct-IP clipboard fallback, empty states, slow transfers, switching/locking mid-load, wrapping, and no private data remaining in hidden previews. Capture sanitized before/after evidence.
- Run repository typecheck, tests/coverage, build, audit and required CI gates, then independent review and current-head bot-comment inspection. Address valid findings before merging under the standing release instructions.
- Deploy with a fresh backup and the existing runtime-only rollback process. Preserve the current device identity/grant, access key, live preferences/layouts, collector and existing preview services. Read-only live smoke checks must leave agent work untouched.

## Decisions reserved for the builder

The builder may choose module/type names, the concrete optional-capability representation, metadata cache details, safe filename encoding, and image-header inspection using the current dependency set. No new dependency, authentication mode, Gateway configuration, public socket payload or agent permission is required by this proposal. Changes to the user-visible scope or bounds above return for review rather than being silently reduced.

The exact source of the prior phone dimming report does not change this design. Preserve the shipped canvas/context recovery and modal cleanup; this work must not add another overlay system.
