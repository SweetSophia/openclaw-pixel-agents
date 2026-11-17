# Agent document editor — first workspace-editing slice

## Intent and scope

The approved phase-two roadmap includes native workspace editing and attachments. The user chose our recommendation to start with bounded text editing and delegated routine design decisions. Native discovery on 2026-11-17 established a narrower safe first slice: an **Agent documents** editor for existing `AGENTS.md`, `SOUL.md`, `USER.md`, and `MEMORY.md` files. This is not a general workspace editor and does not complete all of roadmap task 7.

Build and synthetically qualify this source feature only. Do not enable it, authenticate/pair a new live device, grant admin, deploy, restart services, or edit real agent documents. Those are separate operator actions. Existing Task/Conversation, schedules, roster, collector and live office configuration remain unchanged.

## Native evidence and approach

The inspected installed OpenClaw 2026.11.2 catalog has read-only `agents.workspace.list/get`. `agents.files.get/set` supports a restricted canonical document set; `agents.files.set` requires `operator.admin`. The alternative `sessions.files.set` also requires admin and changes the product boundary to a selected session. A generic tool invocation, remote shell, filesystem fallback or agent task is not a substitute for a confined, revision-checked editor.

Chosen approach: a separate **default-off** document device with an exact local `agents.files.get` / `agents.files.set` allowlist. This follows scheduling's separate-device boundary, not its identity or credentials. A local allowlist does not cryptographically restrict the broader native administrator credential; guides must disclose that risk and independent revocation. All office-key holders remain trusted operators, not separate RBAC users.

Rejected approaches: elevate/reuse the ordinary device or the scheduling device; unrestricted text/path editing; expose session-root writes through the agent-wide Workspace panel. They either broaden existing authority or do not satisfy this slice's identity/confinement contract.

Native agent reads return raw-byte hashes but local decoding can be lossy. Verify re-encoded UTF-8 size and SHA-256 against native metadata before permitting edits. Require both `expectedHash` and `expectedWorkspace` on every save. These are native optimistic conflict checks, not filesystem-atomic CAS against arbitrary external editors: native hash-read and write are separate operations under a process-local queue.

## Fixed boundaries

- No new dependencies. Preserve Node `^22.22.2 || ^24.15.0 || >=26.0.0`, existing HTTP/Origin/transport/auth guards, signed protocol-4 device authentication and private persistence permissions.
- Environment opt-in: `CONTROL_DOCUMENTS_EDIT_ENABLED=true`, default false. Bootstrap credentials are only `OPENCLAW_DOCUMENTS_GATEWAY_TOKEN` or `OPENCLAW_DOCUMENTS_GATEWAY_PASSWORD`; never borrow ordinary or scheduling credentials. Device directory: `DATA_DIR/control-documents`. Disabled means no connection/identity/directory, even with credentials present. Start lazily on an authenticated explicit opening of the document editor, not server startup or ordinary browsing.
- Document names are exactly the four above, case-sensitive and root-only. Only existing files. No create, force overwrite, delete, rename, uploads, attachments, IDENTITY/BOOTSTRAP editing, generic RPC or filesystem access.
- Text is strict round-trippable UTF-8, at most **32 KiB**, including empty text. Reject NUL, non-tab/newline/carriage-return ASCII controls and unpaired surrogates. This keeps the worst escaped request within the unchanged **100kb** Express JSON limit; normal workspace reads retain their existing limits.
- Agent IDs must be canonical registered IDs. Never send an alternate native-normalized ID. Native replies must match exact agent/name/workspace and hash/bytes. Absolute workspace identifiers remain server-side; the browser receives an opaque revision, never a writable host path.
- Editing authority requires a recognized stable Gateway version **2026.11.2 or newer**, negotiated get/set methods and separately granted read/admin scopes. This is the conservative first source-qualified floor, not a claim that every earlier build is unsafe. Reject missing, malformed and prerelease version identities for this profile. Ordinary control grant request, persistence and optional-method behavior must remain unchanged. Missing hash or method/provider contracts fail closed. No live capability claim follows merely from installed source.

## Server behavior

Use separate focused config/service/router modules and a document profile in the existing signed Gateway implementation. The profile permits only the two document RPCs; it exposes status and a connection epoch without leaking credentials. Native conflict details map explicitly; transport loss, cancellation, malformed post-dispatch replies and uncertain failures never become confirmed failure or automatic retry.

Authenticated routes under `/api/control/agents/:id/documents`:

- `GET /status`: lazily start the configured document connection and report management state only.
- `POST /read` with `{name}`: read a validated existing document and return `{agentId,name,revision,content,bytes,source}`. Bind the opaque revision to agent, name, native workspace/hash and exact document connection epoch.
- `POST /save` with `{name,revision,operationId,content}`: preflight current identity/authority; consume the revision before dispatch; issue one native set with both stored preconditions. Return `{agentId,name,operationId,state:'saved'|'conflict'|'unknown',snapshot?}`. A saved snapshot is permitted only after an exact validated native acknowledgement of the submitted content/hash/workspace. A conflict retains the draft and requires a fresh read/review; an unknown outcome does not authorize replay.

Use **32** read tickets and **128** operation records, each at most **10 minutes**, with bounded admission. A consumed/expired/missing revision cannot write. Same operation identity and immutable payload return a retained receipt without another RPC; identity reuse with changed selection/payload is rejected. Once process state is lost, old revisions are invalid, so old submissions cannot be replayed after restart. A new read is an explicit review point, not a silent rebase. Do not journal private document contents.

Invalidate write revisions on source/epoch/config changes and close; check again after awaited reads/writes before publishing. Source changes after dispatch can only produce unknown, not a fresh reusable revision. Keep closed request/reply parsers and existing API error privacy.

## UI behavior

Add an explicit expandable **Agent documents** section inside the private Workspace panel, separate from the read-only browser. No ordinary directory read starts the management connection. Show disabled, pairing, permission, unsupported, connecting and ready states honestly. An explicit selection reads one of the four documents; unsupported/missing/oversized/binary documents cannot be saved.

When a recorded run remains selected in the parent details modal, keep the document editor inactive/read-only and offer **Return to live** before opening its management connection or saving. Existing ordinary Workspace browsing remains available. Agent documents affect the current agent, not a historical run; use the same conservative current-vs-recorded intent boundary as Schedules.

Use plain text editing, visible agent/document identity, byte count and explicit **Save**. There is no autosave. Save requires a changed valid draft, current snapshot/revision/management epoch, and one submission at a time. After conflicts or uncertain outcomes, retain the draft but disable Save until the user explicitly reloads and reviews the current file; never silently replace/rebase typed text or replay the previous operation. A late response must not replace newer input or another agent/document's state. Use `newEntityId()` for operation IDs.

Keep drafts in component/tab memory only, never storage, URLs, public sockets or the collector. Lock, credential-generation change, agent change and final close clear private text. Transient unavailability and a temporarily hidden page retain the draft but invalidate its write revision and cancel reads/confirmation. Returning requires a fresh explicit review. Leaving the Workspace, changing document, closing editor/modal or reloading with dirty text requires an explicit discard decision; native confirmation is sufficient, and page unload should warn. Once a save dispatches, retain that protection while pending or uncertain even if newer typing/undo matches the last loaded snapshot: the submitted text may already be committed. Only an exactly verified saved baseline or explicit fresh read/review resolves that uncertainty. Do not break existing Escape, keyboard tab navigation or focus restoration. AgentWorkspace is already kept mounted by its parent; preserve that pattern.

No new modal or editor framework. Use a labeled textarea and existing component styling; normal-flow layout, 44px actions, readable desktop/phone/short windows, safe text rendering and no canvas keyboard leakage.

## Verification and completion limits

Evidence path: real shared parsers and signed protocol/service/router behavior against controlled native-shaped fixtures, actual native policy/validator qualification, hook/component behavior under asynchronous failure, compiled synthetic production API/browser checks, then repository gates and independent reviews. Test conflicts, UTF-8/raw-hash mismatch, same-operation retries, reconnect/Lock/selection races, malformed post-write acknowledgement and no default-off identity creation. The negative baseline must fail for the named missing guard, not merely a mock expectation.

Run typecheck, full tests, coverage, build, installed package smoke and both existing audits; use exact-source Docker startup when available and record any limit honestly. Browser qualification must exercise the real parent modal with synthetic documents/credentials, not live agent files, and inspect screenshots plus console/privacy/network behavior. Keep public roster/collector payloads free of private bytes.

Source delivery is not activation, admin approval, public npm publication, live mutation acceptance or completion of uploads/general workspace editing. Document the opt-in procedure and remaining external-writer race explicitly.
