# Bounded native image attachments

Date: 2026-11-17

Status: approved by the user on 2026-11-17, including the detailed choices below. The implementation plan and execution handoff are the next gate. No live grant, activation, deployment, release, or publication is authorized; no feature implementation is included in this document.

## Intent and scope

Continue delivery 7 of the [phase-two revamp plan](../plans/2026-10-26-revamp-phase-two.md): let a trusted office operator include one image with a normal follow-up to an explicitly selected, existing conversation. Use the existing private office connection and native `chat.send`; do not create another upload store or elevate a device.

The accepted direction is default-off, PNG/JPEG only, conservative limits, explicit sharing information, immutable submission identity and no automatic replay after an uncertain send. General workspace uploads remain a separate, unqualified delivery.

This is a cross-boundary feature, not a file-picker-only change. It touches private HTTP ingress, Gateway capability negotiation, admission/reconciliation, composer state and error copy. The current `parseSendRequest` rejects attachment fields; its text-only route and retry behavior must remain unchanged.

## Approaches and selection

| Approach | Trade-off and decision |
| --- | --- |
| Native `chat.send` with inline attachment bytes | Chosen by the user. Uses ordinary write authority and the exact conversation target; requires new office-side admission, limits and recovery policy. |
| Stage with `terminal.upload`, then send a path | Not selected. Requires admin authority and an existing terminal; its temporary path is not a general agent-workspace destination or a supported reference-only chat attachment. |
| Write directly into the agent workspace | Deferred. `sessions.files.set` updates existing UTF-8 files, not new binary files. An internal MCP-form workspace-upload provider has form-specific authority; it is not a qualified general operator upload RPC. No local-filesystem, shell, tool-call or generic RPC fallback. |

The approved approach uses a **prepare, review, confirm** adapter. Preparation freezes bytes and target without native upload or task creation. Confirmation admits at most one native send attempt for that preparation. This avoids reusing the text sender's resend-oriented recovery and needs no durable image store.

## Authority and compatibility

- Add `CONTROL_ATTACHMENTS_ENABLED=true` as a separate opt-in, false by default. Ordinary private access and `CONTROL_SEND_ENABLED=true` are also required. Disabling attachments leaves text sends, reads, models, approvals, schedules and document editing independent.
- Use the ordinary signed protocol-4 task device with negotiated `operator.read` / `operator.write`. Never request admin authority, approve pairing, borrow a scheduling/document credential or connect from the browser directly to OpenClaw.
- Require a recognized stable native version at least `2026.11.2`, negotiated `chat.send`, current read/send authority, and valid positive safe-integer `policy.attachments.maxBytes`, `maxImageBytes`, `policy.maxPayload` and `maxBufferedBytes`. Missing, malformed, prerelease or incompatible data disables attachments only; do not fabricate limits from a version string.
- Expose a bounded attachment-specific capability projection and connection epoch on `ControlGateway`, separate from the ordinary status parser. Invalidate prepared authority on disconnect/reconnect, device/endpoint/source change and relevant native invalidation events. Refresh negotiated limits on every new connection.
- Advertised byte ceilings do not prove `gateway.uploads.enabled`, model image support or current authorization. Native upload policy remains authoritative at dispatch. Normalize a policy denial to attachment-specific copy without locking otherwise valid private reads or proposing broader grants.
- Preserve secure transport, exact Origin checks, office-key authentication, mutation limits and the existing actual-socket Tailnet exception. The shared office key represents trusted operators, not per-user RBAC.

## Approved first-slice limits

These coordinator choices are approved requirements, not existing product behavior:

| Boundary | Limit |
| --- | --- |
| Image count | Exactly one; no directories, drag/drop batches, clipboard ingestion or multiple-file fallback |
| File formats | PNG or JPEG; no SVG, GIF, WebP, PDF, archives or arbitrary files |
| Decoded bytes | Nonempty, at most `min(4,194,304, negotiated maxBytes, negotiated maxImageBytes)` |
| Image dimensions | Positive dimensions, each at most 8,192; at most 16,777,216 pixels |
| Message | Existing ordinary-message validation: nonempty, at most 8,000 characters, no command/abort aliases |
| Delivery | Existing-conversation follow-up only; no new conversation, historical mode, Steer, external destination or runtime override |
| Preparation JSON | At most 6 MiB, uncompressed; other API body limits remain 100 KiB |
| Active image slots | Two per office process, including receiving/preparing/prepared/native-response-pending states; reserve up to 4 MiB decoded capacity for each |
| Prepared lifetime | Five minutes, using monotonic elapsed time within the process |
| Receipt lifetime/count | Ten minutes / 128 bounded metadata-only operation records; refuse new admission at capacity rather than evict a live uncertain operation |

The server validates canonical padded base64 before decoding, calculates the actual decoded length, computes SHA-256 itself and ignores browser-provided size/hash claims. It checks PNG/JPEG container headers and bounded dimension parsing (JPEG header scan at most 64 KiB). Truncated/contradictory headers and format mismatches fail closed. This is bounded format screening, not full image decoding, malware scanning or proof that a provider can process the file. Do not add an image decoder or dependency just for a preview.

Filenames are untrusted display labels, never filesystem paths. Produce a bounded plain-text basename of at most 128 characters with no control characters, separators or unsafe platform basenames, and an extension matching the detected format. Show the resulting label during review. Do not interpolate names into commands, system instructions or HTML.

The complete serialized Gateway request, including envelope, target, message and base64, must fit the negotiated `maxPayload`; check encoded bytes rather than adding decoded sizes. Apply a bounded outgoing-buffer check against the negotiated buffer ceiling immediately before sending. Keep the existing incoming response limit unchanged. Capability/limit changes invalidate a preparation instead of silently changing it.

Use a 30-second attachment-specific native request deadline without extending unrelated controls' existing timeouts. Expiry after invocation means unknown outcome, not cancellation or permission to resend; the Gateway may still be processing the original input.

## User experience and privacy

Keep the existing text composer. In live follow-up mode with a selected verified conversation, offer a single **Attach image** picker only when the feature is available. Show the format/byte limit and an unavailable reason otherwise. New conversation and Steer remain text-only; selecting those modes cannot carry a hidden attachment into the ordinary send route.

Selection stays local until **Review image message**. Display filename, detected format, size and dimensions, with Remove. Do not create an image thumbnail or object URL in this slice. The review action explicitly says it uploads the image to the private office server for preparation, not to the Gateway yet.

The prepared review shows the exact agent ID, conversation identity, full submitted message, normalized filename, format, bytes and digest identifier. It remains a separate immutable snapshot if the user edits a newer draft. Only **Send image follow-up** with an unchecked-by-default sharing acknowledgment can confirm that exact snapshot. Ctrl/Cmd+Enter may open review but never bypass confirmation.

Required warning, in plain language:

> The image, including embedded metadata, will be sent to OpenClaw and may be processed by its model and tools. OpenClaw sharing and retention settings apply, including existing or later public session shares. The office does not make the image exclusive to this conversation. Sending cannot be undone by Lock or closing this panel.

Do not claim a public-share detector or a private-session guarantee: neither was qualified. `deliver:false` prevents this send's automatic external-channel delivery; it does not sandbox the agent's tools or override sharing policy. Do not promise that native chat media expires after the terminal uploader's 24-hour retention period.

Keep image bytes/preparation secrets out of browser storage, URLs, public agent state/socket traffic, the collector and request logs. Filename/message/target are also private. The office retains image data in bounded memory only, not on disk; OpenClaw may retain accepted media according to its own settings. Memory reference release is not immediate physical erasure.

Lock, credential-generation change, agent/target change, leaving live Conversation, hidden-page transition and final unmount clear selected image bytes and invalidate the visible review. Best-effort discard may release an unconfirmed server preparation; its short TTL is the fallback, not a guaranteed Lock-time purge of server memory. Existing text-draft behavior is preserved. A late response must not restore cleared image data or confirmation authority.

An admitted operation's small identity/uncertainty marker stays in the private provider while that access generation exists, even if its live form unmounts. Removing the file or switching modes must not turn an unresolved image operation into a fresh text send or make its confirmation reusable. Lock/reload clears local markers; this is not durable browser recovery.

All controls need labels, keyboard operation, visible focus, honest busy/status messages, 44px targets, focus return and narrow-screen/200% text-zoom support within the existing drawer. No canvas/navigation persistence changes.

## Private adapter contract

Create a dedicated `shared/controlAttachments.ts`, server attachment service/router and client attachment hook. The existing text `sendService` remains text-only. Reuse `TaskService.verifyTarget`, ordinary access/provider APIs and existing receipt/history projection where their contracts fit; extract a narrow read-only input-receipt helper if useful rather than duplicating send/retry policy.

All requests and responses use closed, bounded shapes. Proposed routes beneath `/api/control/agents/:id/attachments/` are:

| Route | Input and effect |
| --- | --- |
| `status` | Authenticated capability read; no upload, pairing or task creation |
| `prepare` | Exact `ControlTarget`, ordinary message, one `{ filename, mimeType, contentBase64 }`; validates/captures data and returns server-generated operation/review identities plus safe review metadata |
| `confirm` | Only server-issued operation ID, review token and `sharingAcknowledged:true`; no replacement bytes, target, prompt, native fields or client-selected idempotency key |
| `receipt` | Server-issued operation identity; read-only inspection/reconciliation, never dispatch or re-prepare |
| `discard` | Unconfirmed preparation identity; releases staged memory, never aborts/reverses a send |

All except capability reads use POST to keep private selectors out of URLs. Operation IDs in request bodies are not substitutes for the office key. Reject unknown keys, foreign agents, conflicting identities and malformed values rather than dropping fields. No endpoint accepts arbitrary host paths, media URLs, staged references, native RPC methods or browser-supplied authority.

### HTTP placement and resource admission

The global JSON parser currently runs before private authentication. Do **not** increase that parser's 100 KiB limit. Defer parsing only for the exact POST preparation route; after the existing API Origin/mutation guard and private transport/key checks, acquire an image-slot lease and apply its own 6 MiB JSON parser with compressed bodies disabled and a 30-second body deadline. Use the same private access budget instance rather than mounting a second independent access limiter.

Verify route-predicate/parser parity, trailing-slash behavior and nonmatching methods. All other routes retain normal parsing. Apply bounded preparation rates (at most ten per minute per IP) in addition to the two process-wide image slots. Enforce actual streamed bytes even when Content-Length is absent/false. Release leases exactly once on rejection, body timeout/abort, discard, expiry, service close or settled native request. This bounds concurrent buffering; it does not assert a precise JavaScript heap-byte ceiling.

### Preparation and immutable identity

1. Require current attachment capability and a fresh owned, writable, live target from `TaskService.verifyTarget`. Verify current leaf through a bounded `chat.history` read. A missing/unverifiable active leaf, stale source, viewer/read-only target or any lifecycle/branch mismatch blocks preparation.
2. Validate the image/message and resource budgets. Freeze agent, session key/ID, lifecycle/branch/leaf, connection epoch, exact message, canonical MIME/filename, byte length and SHA-256 of image bytes. Hash a versioned deterministic manifest containing those fields. Never use the native text fingerprint as this manifest.
3. Mint fresh unpredictable server-owned operation and review identities. Retain the immutable payload in memory for five minutes and return only review metadata. No `chat.send`, `sessions.create`, terminal upload, workspace write or media publication occurs during preparation.
4. A lost preparation response cannot have sent a task. The UI can explicitly start a new review, but cannot automatically promote an unseen preparation into a send. Outstanding orphan preparations remain bounded and expire.

### Confirmation and native dispatch

Reserve/coalesce the operation synchronously before any awaited confirmation work. Concurrent/repeated identical confirmation requests join that operation or read its retained receipt; they never create another native send. Expired, consumed, foreign, changed or unknown review identities cannot mint replacement authority.

Recheck configuration, connection epoch, roster ownership, target lifecycle/branch, writability and exact reviewed leaf. An append between review and dispatch requires a new review; do not silently retarget to the newer leaf. Finish all cancellable preflight before invocation, then set the operation's attempt latch immediately before entering the Gateway send API. Disconnecting the HTTP consumer does not cancel, replay or replace that admitted operation.

Construct only:

- `agentId`, `sessionKey`, `sessionId` and `expectedLeafEntryId` from the retained verified target;
- exact frozen `message` and server-generated native `idempotencyKey`;
- `queueMode:'followup'`, `deliver:false`;
- one `attachments` entry containing canonical MIME, normalized filename, `origin:'file'` and canonical base64 bytes.

Do not set origin/channel routes, provenance, suppression, permissions, model/tool/runtime overrides or external delivery. Retain native target preconditions as the final check for races; an office preflight alone is not an atomic session lock.

After the first Gateway invocation, no path calls `chat.send` again for that operation, including an explicit receipt check, reconnect, timeout, page revisit, identical confirmation, expired receipt or server restart. Native request-ID deduplication is additional defense, not the office's replay guarantee.

## Outcomes, recovery and lifecycle

| State | Truth and allowed next action |
| --- | --- |
| Prepared | No native send invoked. Review, discard, or confirm once before expiry. |
| Preflight rejected / review expired | This operation did not invoke native send. Preserve newer text, clear its authority, and require an explicit fresh review. |
| Sending | One attempt is admitted. Disable another confirmation and do not let generic text retry handle it. |
| Accepted | Exact native run ID acknowledged; this is not transcript persistence, image consumption or task success. Check native history read-only. |
| Message recorded | Source-correlated receipt/user event establishes that the message was recorded. It does not by itself verify image bytes or that a model saw them. |
| Attachment reference recorded / omitted / unverified | Project only source-correlated bounded media facts or native omission markers. Names/sizes alone do not prove the persisted image matches our digest. Never label unverified attachment delivery as successful. |
| Outcome unknown after invocation | The request may have been accepted. Keep a small recovery marker and offer **Check original submission**, never Retry/Resend. Absence in a bounded history window is not proof of failure. |

Reconciliation uses exact server-generated native run ID and original target with existing bounded input-receipt/message-ID reads. It must not compare prompts/filenames heuristically, follow another lifecycle or invoke another send. A pending/consumed receipt can establish custody without proving model processing. Native acknowledgment, transcript persistence, attachment-reference persistence, provider consumption and task completion are distinct facts.

An uncertain operation blocks another image confirmation from that composer while its access-generation marker remains. Read-only checks and other private controls stay available. There is no image-operation Retry button or automatic replacement. Clearing an uncertainty marker must not be presented as cancellation or evidence of non-delivery; if a later design needs a manual override, stop and agree that behavior separately.

Release payload references once no longer needed for dispatch; retained operation receipts contain no image/base64/message text. Unconfirmed preparation bytes expire or are discarded. Use monotonic elapsed time, bounded cleanup and `close()` disposal. Timers/cleanup do not grant new authority, erase native media or promise secure memory wiping.

Prepared tokens and receipt caches are process-local, not a journal. A server restart invalidates all old confirmation tokens; a stale confirm/receipt request reports unavailable/expired and **cannot create an operation**. Preparation always issues new server-owned identities, never imports an old operation ID. A new review after restart is an explicit new operator decision, not a retry or an exactly-once guarantee across independently created submissions.

## Native evidence and qualification boundary

Inspected installed OpenClaw `2026.11.2` on 2026-11-17; rechecked its version for this design. The preceding contract qualification passed 27 synthetic probes using actual native exports in a network-disabled, read-only-package Docker container on Node `26.12.1`, with a temporary isolated HOME/state and no real agent data. This is evidence about source/helpers, not live policy, grants, public-share status, model inference or deployment. The probe count is historical qualification, not a newly executed feature test suite.

Relevant installed bundle/source regions:

- `sessions-CVESrViJ.mjs:2424–2508`: permissive attachment envelope, closed `ChatSendParamsSchema`, session/leaf guards and required native idempotency key.
- `session-create-root-BbVnpnvF.mjs:47–67,307–345` (`attachment-normalize.ts`, `chat-send-request.ts`): content-bearing normalization and request fingerprint excluding attachments. The probe confirmed changed bytes/name/MIME with the same text yield the same keyed identity.
- `chat-attachments-B_qr07LN.mjs:174–293`: base64 payload processing, actual decoded-byte checks, sniffing, 6 MiB image ceiling, shared managed-media offload and text-only image omission after ten. Native attachment decoding accepts some noncanonical pad bits; the office's canonical-only rule is deliberately stricter. The probe exercised text-file offload, inline PNG, text-only image offload and omission.
- `chat-send-handler-BTZ6ecuc.mjs:3807–3825,4415–4421`: request-conflict comparison and ordinary attachment sends excluded from the traced restart-safe eligibility path. Do not infer universal exactly-once recovery from other chat documentation.
- `control-ui-3NoZnYpB.mjs:217–229,686–724` and `control-ui-public-session-media-BbjXRY_A.mjs:75–94`: broad native media-reader authority, ticketed reads and selected public-share image serving. Source-traced privacy, not a live authorization probe.
- `workspace-files-CU_elrcH.mjs:338–382`, `terminal-file-upload-CpFIT6ug.mjs:260–321`, `mcp-app-form-resources-Gx8hcMYv.mjs:310–360`: existing-file edit, private temporary terminal staging and form-specific workspace publication, respectively.

Official background: [attachment policy and encoded frame checks](https://docs.openclaw.ai/gateway/protocol/handshake#attachment-limits), [terminal upload](https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol/rpc-system-and-channels.md). Current upstream documentation may describe broader or newer behavior; the installed source and controlled tests are the qualification anchor. Requalify on native contract changes.

## Implementation evidence required after approval

Use test-driven, thin implementation slices. These are acceptance requirements, not a detailed execution plan:

1. **Pure contracts:** strict parsers, base64 edge cases, independent size/hash computation, Unicode/path labels, PNG/JPEG and bounded dimension checks, command rejection, frame-size/buffer limits and older/malformed handshakes. No new dependency without a justified need.
2. **HTTP boundary:** process-level tests prove unauthorized/wrong-Origin/insecure/disabled requests are rejected before large buffering, only preparation gets the larger parser, compressed/chunked/aborted/slow/oversized bodies are bounded, and slots/rate budgets recover without leaks. Preserve existing rate-limit, ingest and ordinary API tests.
3. **Real private adapter against a signed synthetic Gateway:** no sends during preparation; exact one image/native envelope; changed/foreign/expired tokens rejected; duplicate confirms coalesce; target/leaf/epoch/config/roster races; thrown/lost/malformed/late acknowledgments; `UPLOADS_DISABLED` remains local to attachments; no ordinary text-regression or privilege expansion.
4. **Restart/no replay:** actual office child-process restart after synthetic native admission and a lost acknowledgment. Replaying the old confirm must produce zero new native sends; read-only checks must never dispatch. Also test a lost preparation reply and restart before dispatch. Same-process service recreation is not equivalent evidence.
5. **Client integration:** private-access generation and target fences, byte clearing, double-click/keyboard confirmation, newer draft preservation, original target display, uncertainty marker surviving live-form remount, no generic Retry leakage, honest image-reference states, and recorded/new/Steer suppression.
6. **Synthetic production browser:** keyboard/focus and 44px hits at 320/390/768/1024/1440px, short landscape and 200% text zoom; lock/hide/unmount/races; source denial/unknown recovery; console/network/storage/public-socket inspection. Use only synthetic images/messages and owned temporary resources. No live upload or task send.
7. **Repository gates:** supported Node, `npm ci`, typecheck, full tests/coverage, build, installed-package smoke, Docker API/SPA smoke and both audit gates from [CONTRIBUTING.md](../../../CONTRIBUTING.md); independent code review and exact-head CI before proposing merge. No performance claim from jsdom or unit tests alone.

## Choices left to the builder and approval boundary

Within these contracts, the builder may choose module internals, narrow reusable helpers, status/error type names, CSS arrangement and fixture structure. Keep the existing React/TypeScript/Express stack. Do not broaden formats, delivery modes, permissions, storage or retry semantics as an implementation convenience.

Approved coordinator choices are the 4 MiB/single-image and dimension caps, existing-follow-up-plus-text restriction, metadata-only local review, prepare/confirm with short memory-only tokens, and fail-closed unknown-outcome behavior.

Next gate: self-reviewed implementation plan and user execution handoff. Source implementation, GitHub publication/merge, live activation, permission changes and releases remain distinct steps; this document authorizes none of those operational actions by itself.

Builder check: an independent fresh-context software-engineer reviewer read the draft on 2026-11-17 and reported "nothing important left" to answer before planning. The reviewer checked the subsequent separate 30-second native deadline and native/office base64 strictness clarification and again reported no consequential unanswered question. The user subsequently approved this design.
