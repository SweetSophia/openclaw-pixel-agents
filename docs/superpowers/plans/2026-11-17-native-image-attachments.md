# Native Image Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach one bounded PNG/JPEG and ordinary text to a selected existing conversation through a separately enabled, private, no-replay native adapter.

**Architecture:** Keep text sending unchanged. An authenticated, resource-bounded prepare route validates and freezes the image, message, target and source epoch; a separate confirmation permits one native `chat.send` attempt. Server-issued memory-only authority expires rather than being recreated after restart, and uncertain submissions have read-only reconciliation.

**Tech Stack:** Existing React, TypeScript, Express 5, Node crypto/Buffer, signed protocol-4 Gateway connection, Vitest/Supertest and synthetic production-browser acceptance; no new dependency planned.

**Spec:** [Approved design](../specs/2026-11-17-native-image-attachments-design.md). Read it completely; this plan decides interfaces, not a replacement safety contract.

## Global Constraints

- Feature opt-in is `CONTROL_ATTACHMENTS_ENABLED=true`, false by default; ordinary private access and `CONTROL_SEND_ENABLED=true` are also required. Existing task-device read/write scopes only; no pairing, admin request, alternate credential or browser-to-Gateway connection.
- Require recognized stable Gateway `2026.11.2` or newer, negotiated `chat.send`, read/send authority and positive safe-integer attachment/frame/buffer limits. Missing/invalid attachment policy disables attachments only.
- Exactly one PNG or JPEG, nonempty, at most `min(4,194,304, negotiated maxBytes, negotiated maxImageBytes)` decoded bytes; dimensions each at most 8,192 and at most 16,777,216 pixels; JPEG header scan at most 64 KiB. Canonical padded base64 only. Server computes actual bytes, type and SHA-256.
- Existing-conversation follow-up with nonempty ordinary text of at most 8,000 characters only; no commands/abort aliases, new conversation, recorded mode, Steer, external destination or runtime override. Native `queueMode:'followup'`, `deliver:false`, exact session ID and reviewed leaf are mandatory.
- Only exact POST preparation gets an uncompressed 6 MiB parser, after Origin/mutation/private transport/key admission. Other API limits stay 100 KiB. Two process-wide image slots reserve up to 4 MiB decoded each, covering receiving through native-response settlement; ten preparations/minute/IP. Body and attachment-native deadlines are each 30 seconds; ordinary request deadlines stay unchanged.
- Preparations live five minutes; metadata-only receipts live ten minutes, maximum 128, without evicting live operations to admit another. Use monotonic elapsed time and bounded cleanup; shutdown disposes all owned state. No image/prompt journal, secure-erasure promise or native-media deletion promise.
- Never invoke native send during prepare. Freeze the complete manifest; coalesce confirmations before awaits and latch before the first Gateway invocation. No resend after invocation, including explicit receipt checks, reconnects, repeated confirms or office restart. Old tokens cannot create new operations.
- Review uses metadata, not a thumbnail/object URL. Show the design's exact sharing warning and require an unchecked-by-default acknowledgment. Clear image data/review on lock/generation/agent/target/hide/unmount; preserve unrelated text behavior and private admitted-operation markers across form remounts.
- Never put private image, filename, prompt, target or review token in browser storage, URLs, logs, public agent/socket payloads or the collector. Do not claim session-exclusive storage, provider consumption or image-byte persistence from a message acknowledgment/reference.
- Work in the existing isolated branch `feat/native-image-attachments`. Before execution verify clean state, supported project Node (`^22.22.2 || ^24.15.0 || >=26.0.0`), run `npm ci` and a fresh full baseline. Preserve the user's main checkout and `.gitignore`. Use `apply_patch`; before GitHub writes verify `gh api user --jq .login` is exactly `SweetSophia`.
- No live credentials, real agent data/tasks/uploads, new grants, activation, deployment, release or npm publication. Synthetic tests alone do not authorize those steps. Do not push/open/merge a PR without the corresponding user direction.

## Review Focus

1. **Small compressed or slow chunked HTTP bodies** must not bypass decoded limits, deadlines or authenticated buffering; pin in Task 5.
2. **Conversation append/branch or source change during a still-connected confirmation preflight** must fail closed rather than silently follow the new leaf; pin in Task 4 and Task 2's final transport gate.
3. **Leaving and reopening the live composer during a lost confirmation reply** must preserve uncertainty and never expose a text Retry path for the image operation; pin in Tasks 6–7.
4. **A recorded user message with omitted, malformed, foreign or missing media facts** must not appear as successful image delivery or leak a native media path; pin in Task 4.
5. **Wall-clock rollback, lost preparation replies and unconfirmed expirations** must not revive authority or leak image slots, and expired receipt lookups must not dispatch; pin in Tasks 3 and 8.

---

## File map and dependency order

| Task | Owns | Existing boundaries preserved |
| --- | --- | --- |
| 1 | `shared/controlAttachments.ts`, `shared/imageAttachment.ts`, `server/control/attachmentPayload.ts`, config flag and typed errors | `shared/control.ts` ordinary send shape remains closed/text-only |
| 2 | `server/control/gatewayAttachmentPolicy.ts`, `gatewayVersion.ts`, narrow `gatewayClient.ts` integration | Signed authentication, response ceiling, existing profiles/methods and ordinary timeouts |
| 3 | `server/control/attachmentAdmission.ts` | No native/filesystem/network work; bounded memory authority/lifecycle |
| 4 | `server/control/attachmentService.ts`, `attachmentReceipt.ts`, signed fixture | Existing `TaskService.verifyTarget` and text `sendService` behavior |
| 5 | `server/control/attachmentIngress.ts`, `attachmentRoutes.ts`, `routes.ts`, `server/index.ts` wiring | Existing mutation guards, one private access budget, all other 100 KiB routes |
| 6 | `src/control/useImageAttachments.ts`, private marker context, `api.ts` error copy | `ControlAccessProvider` key lifecycle and unrelated drafts |
| 7 | `src/components/ConversationAttachment.tsx`/CSS, `AgentConversation.tsx`, narrow composer guard | Existing text send/retry, historical/new/Steer behavior and drawer geometry |
| 8 | Process/browser qualification, operator documentation and package smoke | No native/live mutations; normal repository quality/review gates |

Tasks 1–5 deliver the private backend in dependency order; 6–7 deliver its UI; 8 qualifies the integrated branch. Each task owns its tests, red/green cycle and atomic commit. Do not parallel-edit shared files; finish the chosen review gate before the next dependent task.

## Cross-task type ledger

Task 1 exports these exact names from `shared/controlAttachments.ts`; parsers reject unknown/reserved keys and validate phase-dependent fields, rather than casting raw objects:

```ts
type AttachmentMime = 'image/png' | 'image/jpeg';
interface AttachmentImage { filename: string; mimeType: AttachmentMime; bytes: number; width: number; height: number; sha256: string }
interface AttachmentPrepareRequest { target: ControlTarget; message: string; image: { filename: string; mimeType: AttachmentMime; contentBase64: string } }
interface AttachmentConfirmRequest { operationId: string; reviewToken: string; sharingAcknowledged: true }
interface AttachmentOperationRequest { operationId: string }
interface AttachmentStatus { enabled: boolean; canPrepare: boolean; reason: 'disabled' | 'permission' | 'unsupported' | 'unavailable' | null; epoch: string | null; maxBytes: number | null }
interface AttachmentReview { operationId: string; reviewToken: string; target: ControlTarget; message: string; image: AttachmentImage; manifestDigest: string; expiresInMs: number }
type AttachmentImageEvidence = 'unverified' | 'reference-recorded' | 'omitted';
interface AttachmentReceipt {
  operationId: string; target: ControlTarget; phase: 'prepared' | 'not-dispatched' | 'sending' | 'accepted' | 'recorded' | 'rejected' | 'unknown';
  nativeInvoked: boolean; imageEvidence: AttachmentImageEvidence; runId?: string; messageId?: string; messageSeq?: number;
  reason?: 'changed' | 'expired' | 'permission' | 'unsupported' | 'unavailable' | 'uploads-disabled';
}
```

`runId` is the server-owned operation ID used as native idempotency key, never a client-supplied replacement. `recorded` requires a correlated nonempty message ID and positive safe-integer sequence; `accepted/recorded/rejected/unknown` imply invocation. `prepared/not-dispatched` imply no invocation. `sending` may include preflight, so its copy must not assert that native upload has begun. `rejected` is reserved for an explicitly source-qualified native rejection such as `UPLOADS_DISABLED`; other post-invocation failures remain unknown. Receipt fields never contain image bytes, review tokens or message text.

### Task 1: Strict wire, image and configuration contracts

**Files:** Create `shared/controlAttachments.ts`, `shared/controlAttachments.test.ts`, `shared/imageAttachment.ts`, `shared/imageAttachment.test.ts`, `server/control/attachmentPayload.ts`, `server/control/attachmentPayload.test.ts`. Modify `server/control/config.ts`, `config.test.ts`, `shared/control.ts` error union only; `.env.example` gains default-false flag with source-feature warning.

**Interfaces:** Produces ledger types; `ATTACHMENT_LIMITS` with every numeric limit above; `parseAttachmentPrepareRequest`, `parseAttachmentConfirmRequest`, `parseAttachmentOperationRequest`, `parseAttachmentStatus`, `parseAttachmentReview`, `parseAttachmentReceipt` (each `(value: unknown) => T | null`); `inspectAttachmentImage(bytes: Uint8Array): { mimeType: AttachmentMime; width: number; height: number }`; `normalizeAttachmentFilename(name: string, mime: AttachmentMime): string`. The server payload module exports `ValidatedAttachmentPayload { contentBase64: string; image: AttachmentImage }` and `validateAttachmentPayload(input: AttachmentPrepareRequest['image'], maxBytes: number): ValidatedAttachmentPayload` (throws `ControlError` on invalid data). `ControlConfig.attachmentsEnabled?: boolean` preserves existing fixture compatibility; loader always emits a boolean and consumers require `=== true`.

- [ ] **Step 1: Write `strict_image_contracts` and `actual_bytes_override_claims` tests.** Pin closed outer/image objects, foreign/reserved keys, exactly one image object, no paths/URLs/reference-only aliases, canonical alphabet/padding/pad bits, NUL/Unicode labels, reserved basenames, empty/oversized bytes, PNG signature/IHDR and baseline/progressive JPEG SOF headers, truncated/64 KiB JPEG scans, MIME mismatch, 8,192 dimension/16,777,216 pixel limits, 8,000-character ordinary text/command rules and flag parsing. Include concrete boundary assertions:
  ```ts
  expect(validateAttachmentPayload(pngAtFileLimit, 4_194_304).image.bytes).toBe(4_194_304);
  expect(() => validateAttachmentPayload(pngAtFileLimit, 4_194_303)).toThrow();
  expect(parseAttachmentConfirmRequest({ operationId, reviewToken, sharingAcknowledged: false })).toBeNull();
  expect(Buffer.from(pngWithNonzeroPadBits, 'base64')).toEqual(pngBytes);
  expect(() => validateAttachmentPayload({ ...pngInput, contentBase64: pngWithNonzeroPadBits }, 4_194_304)).toThrow();
  expect(parseSendRequest('main', { ...validTextSend, image: pngInput })).toBeNull();
  ```
- [ ] **Step 2: Run `npm test -- shared/controlAttachments.test.ts shared/imageAttachment.test.ts server/control/attachmentPayload.test.ts server/control/config.test.ts`.** Expect missing exports/failing new assertions, not an environment error; capture the red result.
- [ ] **Step 3: Implement the named interfaces.** Keep header/filename helpers browser-safe and decode/hash only in the server module; release temporary decoded buffers after computing descriptors. Do not add a decoder, dependency, persistence path or ordinary-send field. Add only `attachment-denied`, `attachment-changed`, `attachment-expired`, `attachment-outcome-unknown` to the existing error vocabulary where needed.
- [ ] **Step 4: Repeat Step 2 plus `npm run typecheck`.** Expect all targeted tests/types green; assert SHA-256 against known fixture bytes and negotiated lower limits, not the request's hints.
- [ ] **Step 5: Stage only Task 1 files and commit `feat: define strict image attachment contracts`.** Record red/green evidence; complete the chosen review gate before Task 2.

### Task 2: Qualified native image transport without widening ordinary requests

**Files:** Create `server/control/gatewayAttachmentPolicy.ts`/`.test.ts`, `gatewayVersion.ts`/`.test.ts`; modify `gatewayClient.ts`/`.test.ts`. Existing document-version checks may reuse the small version helper without changing their acceptance.

**Interfaces:** Produces `AttachmentGatewayCapabilities { epoch: string; sourceKey: string; maxBytes: number; maxImageBytes: number; maxPayload: number; maxBufferedBytes: number }`. `NativeImageFollowup` has exactly `{ agentId: string; sessionKey: string; sessionId: string; expectedLeafEntryId: string; message: string; idempotencyKey: string; queueMode: 'followup'; deliver: false; attachments: [{ mimeType: AttachmentMime; fileName: string; origin: 'file'; content: string }] }`. `NativeImageRequestFrame` has exactly `{ type: 'req'; id: string; method: 'chat.send'; params: NativeImageFollowup }`. Add optional `ControlGateway.attachmentCapabilities(): AttachmentGatewayCapabilities | null` and `sendImageFollowup(input: NativeImageFollowup, expectedEpoch: string): Promise<unknown>`. `sourceKey` is a backend-only stable identity for validated endpoint/device; epoch changes on reconnect. Public status never exposes source URLs, grants or identity material. Produces `supportsStableGatewayVersion(version: string, minimum: string): boolean` and `serializeImageFollowupFrame(frame: NativeImageRequestFrame, caps: AttachmentGatewayCapabilities, bufferedBytes: number): string`, checking the actual complete JSON frame with its real request ID, not a payload-size estimate.

- [ ] **Step 1: Write `image_policy_is_optional_to_text`, `image_dispatch_checks_current_epoch_and_frame` and `uploads_disabled_does_not_lock_reader`.** Malformed/missing/older/prerelease version or policy disables images without breaking ready text reads/sends; safe-integer limits, shrinking buffer/frame budgets, multibyte/escaped text, final epoch race and exact encoded bytes are pinned. A signed synthetic hello negotiates no new scope/method. Check native `FORBIDDEN/details.code=UPLOADS_DISABLED` is attachment-specific and preserves `canRead`.
  ```ts
  expect(gateway.status().canSend).toBe(true); expect(gateway.attachmentCapabilities?.()).toBeNull();
  expect(socketFrames.filter(f => f.method === 'chat.send')).toHaveLength(0); // stale epoch / too-large frame
  await vi.advanceTimersByTimeAsync(5_000); expect(ordinaryRequestSettled).toBe(true); expect(imageRequestSettled).toBe(false);
  await vi.advanceTimersByTimeAsync(25_000); expect(imageRequestSettled).toBe(true);
  ```
- [ ] **Step 2: Run `npm test -- server/control/gatewayAttachmentPolicy.test.ts server/control/gatewayVersion.test.ts server/control/gatewayClient.test.ts`.** Expect new-interface assertions to fail before implementing them.
- [ ] **Step 3: Implement the capability and narrow send methods.** Retain policy only for a validated accepted hello; clear it on failure. Use the existing signed connection/pending machinery with image-specific classification/deadline, serialize once, and check current epoch plus existing buffered amount plus the outgoing frame immediately before socket send. Never wait for reconnect/drain or retry. Reject an `attachments` field on ordinary `request('chat.send', ...)` so new callers cannot bypass this boundary. No admin/profile expansion or response-limit increase.
- [ ] **Step 4: Repeat Step 2 plus typecheck.** Exercise real fixture frames, image timeout/disconnect/malformed replies and unchanged document/model/approval/ordinary behavior; passing mocked policy helpers alone is insufficient.
- [ ] **Step 5: Commit `feat: qualify bounded native image dispatch`.** Complete the chosen review gate before the next task.

### Task 3: Memory-only admission, leases and one-attempt identity

**Files:** Create `server/control/attachmentAdmission.ts` and `.test.ts`.

**Interfaces:** Consumes Task 1 payload/review/receipt types and Task 2 capabilities. Produces `createAttachmentAdmission(options?: { now?: () => number }): AttachmentAdmission` with `acquire(): AttachmentLease`, `beginPreparation(lease: AttachmentLease): void`, `prepare(input: { target: ControlTarget; message: string; payload: ValidatedAttachmentPayload; connection: AttachmentGatewayCapabilities; lease: AttachmentLease }): AttachmentReview`, `confirm(agentId: string, request: AttachmentConfirmRequest, start: (operation: AttachmentDispatch) => Promise<AttachmentReceipt>): Promise<AttachmentReceipt>`, `read(agentId: string, operationId: string): AttachmentOperationMeta | null`, `record(receipt: AttachmentReceipt): AttachmentReceipt`, `discard(agentId: string, operationId: string): void`, `invalidatePrepared(): void`, `close(): void`. Export `AttachmentLease { release(): void }`, `AttachmentDispatch { review: Readonly<AttachmentReview>; payload: Readonly<ValidatedAttachmentPayload>; connection: Readonly<AttachmentGatewayCapabilities>; readonly nativeInvoked: boolean; attempt<T>(send: () => Promise<T>): Promise<T> }`, and `AttachmentOperationMeta { receipt: AttachmentReceipt; sourceKey: string; image: AttachmentImage; submittedTextDigest: string }`. The digest is SHA-256 of the submitted message after `.trim()` only, for conservative exact-prefix omission checks; it is backend-private and is not a replacement for the full immutable manifest. Metadata retains no payload/message/token. Task 4 review correction: `beginPreparation` validates a still-live receiving lease and transfers it into preparing custody before awaits, without minting a review or reviving dead leases; service releases on failure/abort/close or transfers into prepared ownership.

- [ ] **Step 1: Write `duplicate_confirmation_has_one_attempt`, `monotonic_expiry_releases_orphan_slots`, `capacity_never_evicts_live_operation`, `late_ack_cannot_downgrade_recorded_receipt` and `old_identity_cannot_create_operation`.** Pin two slots across all image states, five-minute preparation/ten-minute metadata lifetime, 128 records, foreign agent/token, changed acknowledgment, pre-await coalescing, discard-versus-confirm, epoch invalidation and close during pending work.
  ```ts
  expect(() => admission.acquire()).toThrow(); // after two live leases
  expect(start).toHaveBeenCalledTimes(1); expect(nativeSend).toHaveBeenCalledTimes(1); // concurrent confirms
  monotonicNow += 300_001; wallClock -= 86_400_000;
  expect(admission.read('main', expiredOperationId)).toBeNull();
  await expect(freshAdmission.confirm('main', oldConfirm, start)).rejects.toThrow();
  ```
- [ ] **Step 2: Run `npm test -- server/control/attachmentAdmission.test.ts` and capture intentional red assertions.** Async APIs use `rejects` rather than synchronous `toThrow` where applicable.
- [ ] **Step 3: Implement the bounded store.** Generate server-owned operation IDs and independent unpredictable review tokens; hash the versioned deterministic manifest including raw target/leaf, source epoch, exact text, canonical filename/MIME/length/image digest. Freeze the target/descriptor/review graphs and return defensive copies on external reads. Coalesce before awaits; `attempt` latches before invoking its callback and cannot be called twice. Record monotonic receipts: a late accepted/unknown result cannot overwrite previously established recorded evidence or revive a prepared token. Payloads/leases survive only until discard/expiry/settled invocation; metadata cannot reconstruct them. Use monotonic cleanup, idempotent lease release and no filesystem/network work. Never renew/replace an unknown ID.
- [ ] **Step 4: Repeat Step 2 plus typecheck.** Include a large synthetic payload weak-reference/retained-field check where deterministic; do not claim physical memory erasure from GC behavior.
- [ ] **Step 5: Commit `feat: add bounded one-attempt image admission`.** Complete the chosen review gate before the next task.

### Task 4: Target-bound service and read-only reconciliation

**Files:** Create `server/control/attachmentService.ts`/`.test.ts`, `attachmentReceipt.ts`/`.test.ts`, `fixtures/attachments.ts`. Leave `sendService.ts` unchanged; share a narrow read-only helper only if a concrete duplication warrants it.

**Interfaces:** Produces `createAttachmentService({ gateway, tasks, enabled, registeredAgentIds, admission }): AttachmentService`, with `status(agentId: string): AttachmentStatus`, `acquirePreparation(agentId: string): AttachmentLease`, `prepare(agentId: string, input: AttachmentPrepareRequest, lease: AttachmentLease, signal?: AbortSignal): Promise<AttachmentReview>`, `confirm(agentId: string, input: AttachmentConfirmRequest): Promise<AttachmentReceipt>`, `receipt(agentId: string, input: AttachmentOperationRequest, signal?: AbortSignal): Promise<AttachmentReceipt>`, `discard(agentId: string, input: AttachmentOperationRequest): void`, `close(): void`. `enabled: () => boolean` and `registeredAgentIds: () => ReadonlySet<string>` are checked at admission and commit, not supplied by the browser. `projectAttachmentEvidence(message: unknown, image: AttachmentImage, submittedTextDigest: string): AttachmentImageEvidence` receives only an already source-correlated native user message and Task 3's retained private digest, never retained message text.

- [ ] **Step 1: Write `prepare_never_sends`, `connected_leaf_race_blocks_confirmation`, `lost_ack_checks_never_resend` and `recorded_text_is_not_image_success`.** Use owned/foreign/read-only/viewer/stale/missing-leaf targets; mutate lifecycle/branch/leaf/roster/source while still connected during preflight. Pin exact native envelope and no extra fields. Repeated HTTP cancellation/native timeout/malformed/different-run ACK, reconnect, expired lookup and duplicate confirm must keep native send count at most one.
  ```ts
  expect(nativeSends).toHaveLength(0); // after preparation
  expect(nativeSends[0].params).toMatchObject({ queueMode: 'followup', deliver: false, sessionId: target.sessionId, expectedLeafEntryId: target.activeLeafEntryId });
  expect(nativeSends[0].params.attachments).toHaveLength(1);
  expect(await service.receipt('main', operation)).toMatchObject({ phase: 'recorded', imageEvidence: 'unverified' });
  expect(nativeSends).toHaveLength(1); // after multiple read-only checks
  ```
- [ ] **Step 2: Run `npm test -- server/control/attachmentService.test.ts server/control/attachmentReceipt.test.ts server/control/sendService.test.ts`.** Capture new-test failures before service code; preserve text tests unchanged.
- [ ] **Step 3: Implement service orchestration and safe projection.** Capture capabilities and exact owned target; verify current `chat.history.sessionInfo.activeLeafEntryId` with limit 1 on prepare/preflight, require the reviewed nonempty leaf, and re-fence source after each await. Enter the store's attempt callback once, then use only `sendImageFollowup`. Pre-invocation failures are `not-dispatched`; exact typed upload denial is `rejected`; unqualified invocation failures are `unknown`. Keep admitted confirmation independent of the HTTP consumer's abort signal.

  Receipt reconciliation pins source key and original target/lifecycle, uses `chat.history` limit 50 / maxBytes 256 KiB / exact `inputRunIds:[operationId]`, then at most one exact consumed message-ID lookup. Native `__openclaw.runId` or consumed-event identity plus valid message ID/sequence establishes recorded text; absence never proves failure. Inspect bounded `__openclaw.media`/`mediaImageLayout` facts, as persisted in native `user-turn-transcript.metadata-CtXLmxDa.mjs:42–68` and `session-actor-memory-owner-D_KZLek8.mjs:5845–5858`; require exactly one unambiguous matching image fact and a canonical first-level inbound URI for `reference-recorded`. Never forward that URI/path. Only an exact known native omission suffix whose preceding text hashes to `submittedTextDigest` can establish `omitted`; do not retain/reconstruct the original text. Markers already present in user input, native text normalization differences, clipped/unknown shapes or metadata-only guesses remain unverified. Neither result claims byte-hash or provider-consumption verification.
- [ ] **Step 4: Repeat Step 2 plus typecheck.** Fixture assertions must inspect actual native frames and returned safe projections; cover both pending/consumed custody and missing/truncated/foreign/contradictory media facts.
- [ ] **Step 5: Commit `feat: add target-bound image follow-ups and reconciliation`.** Complete the chosen review gate before the next task.

### Task 5: Authenticated HTTP body admission and runtime integration

**Files:** Create `server/control/attachmentIngress.ts`/`.test.ts`, `attachmentRoutes.ts`/`.test.ts`; modify `server/control/routes.ts`, `server/index.ts`; extend `server/rateLimit.test.ts` for parser order.

**Interfaces:** Produces `isAttachmentPreparationRequest(req: { method: string; originalUrl: string }): boolean`, `createAttachmentPreparationIngress(service: AttachmentService): RequestHandler`, `createAttachmentRouter(service: AttachmentService): Router`. Use one shared predicate for the global parser deferral and the route's preparation guard; canonical literal route segments, a valid raw agent ID and optional trailing slash only. Encoded/alternate aliases fall back to ordinary bounded handling or rejection, never a larger unauthenticated path. The ingress acquires the service lease after the existing single `createControlAccess` middleware, owns the six-MiB parser/body deadline/IP budget and hands its lease to `service.prepare` without a browser-controlled field.

- [ ] **Step 1: Write `auth_precedes_large_body_read`, `only_prepare_gets_large_parser` and `slow_chunked_compressed_body_is_bounded`.** Send actual HTTP streams, not only Supertest buffered bodies: unauthorized/insecure/wrong-Origin/disabled, missing/false Content-Length, gzip, unsupported content type, aborted/over-limit chunks, ten/minute/IP, a stalled 30-second request and two occupied slots. Repeat with trailing slash, encoded agent, case/extra path segments and non-POST methods. Count preparation/native calls and demonstrate no slot leak or independent duplicate access budget.
  ```ts
  expect(unauthorizedPreparationParserCalls).toBe(0); // not a claim that TCP/kernel buffers read no bytes
  expect(ordinaryLargeRequest.status).toBe(413);
  expect(authorizedPreparation.status).toBe(200);
  expect(nativeSends).toHaveLength(0);
  expect(availableSlotsAfterAbort).toBe(2);
  ```
- [ ] **Step 2: Run `npm test -- server/control/attachmentIngress.test.ts server/control/attachmentRoutes.test.ts server/rateLimit.test.ts server/spa.test.ts`.** Capture the absent-route/order failures before integration.
- [ ] **Step 3: Mount the dedicated routes and lifecycle.** Deferral is a thin conditional around the existing global 100 KiB parser, after unchanged API guards. Mount `GET status` plus closed `POST prepare/confirm/receipt/discard` beneath the existing authenticated control router; no selectors/tokens in query strings. All replies are no-store and generic errors omit private bodies. Dispose attachment service on server close, including imports/tests that never call `startServer()`. `discard` is idempotent only for unconfirmed ownership and cannot cancel an admitted operation.
- [ ] **Step 4: Repeat Step 2 plus typecheck.** Run existing control-access/route tests to prove text/read/model/approval/scheduling/document behavior is unaffected; use real socket counters for pre-parser claims.
- [ ] **Step 5: Commit `feat: integrate authenticated image preparation endpoints`.** Complete the chosen review gate before the next task.

### Task 6: Private client image state and remount-safe uncertainty

**Files:** Create `src/control/useImageAttachments.ts`/`.test.tsx`; modify `ControlAccess.tsx`/`.test.tsx`, `api.ts`/`.test.ts`. Keep raw image data out of the existing shared text-draft map.

**Interfaces:** Produces `useAttachmentOperations(): Map<string, AttachmentClientOperation>` from the private provider; `AttachmentClientOperation { operationId: string; target: ControlTarget; generation: number; phase: 'confirming' | 'unknown' | 'accepted' | 'recorded' | 'rejected' | 'not-dispatched'; receipt?: AttachmentReceipt }` never stores file data/review secrets/message. `useImageAttachments(options: { agentId: string; target: ControlTarget | null; active: boolean; readOnly: boolean; isNew: boolean; intent: 'followup' | 'steer'; message: string; textPending: boolean; onRecorded(submittedMessage: string): void }): AttachmentForm`. Export `AttachmentForm` with `status: AttachmentStatus | null`, `selection: Omit<AttachmentImage, 'sha256'> | null`, `review: AttachmentReview | null`, `receipt: AttachmentReceipt | null`, `phase: 'idle' | 'reading' | 'preparing' | 'review' | 'confirming' | 'accepted' | 'recorded' | 'not-dispatched' | 'rejected' | 'unknown'`, `disabledReason: string`, `pending: boolean`, `select(file: File | null): Promise<void>`, `prepare(): Promise<void>`, `confirm(sharingAcknowledged: boolean): Promise<void>`, `check(): Promise<void>`, `remove(): void`. Selected `File`/bytes and frozen message remain hook-local; markers are keyed by access generation and stable `targetIdentity` (original leaf is retained inside the operation). After an unmount loses the frozen text, a later recorded receipt must not clear current text by guessing.

- [ ] **Step 1: Write `lock_clears_image_not_late_restore`, `remount_keeps_unknown_without_bytes`, `newer_text_is_not_overwritten`, `pending_text_cannot_be_bypassed_with_image` and `check_never_reposts_confirmation`.** Exercise delayed File reads/prepares/confirms, hidden page, unmount, active leaf change, agent/target/new/history/Steer changes, lost prepare response, absent/expired receipt and original-versus-current draft. Provider generation change clears markers and images; unrelated drafts follow existing behavior. Native policy denial shows local attachment copy, not global lock.
  ```ts
  expect(storageWrites).toHaveLength(0); expect(objectUrlCalls).toHaveLength(0);
  expect(confirmRequests).toHaveLength(1); // after remount and repeated Check
  expect(form.selection).toBeNull(); expect(form.phase).toBe('unknown');
  expect(onRecorded).toHaveBeenCalledWith(originalSubmittedMessage);
  ```
- [ ] **Step 2: Run `npm test -- src/control/useImageAttachments.test.tsx src/control/ControlAccess.test.tsx src/control/api.test.ts`.** Capture intentional missing-hook/provider assertions.
- [ ] **Step 3: Implement the hook and marker context.** Validate every response with Task 1 parsers and exact operation/target binding; fence File reads and every await with generation/selection tokens. An unsettled ordinary text submission blocks image preparation/confirmation. A review is immutable; edits do not change its confirm body. Mark confirmation uncertainty before the request; unknown checks never dispatch or recreate preparation/confirmation. Clear bytes on all design transitions; best-effort cleanup discard uses existing private access and cannot restore UI state. A prepared Check snapshot alone cannot prove that an earlier confirmation will not dispatch: establish server discard and reread a terminal not-dispatched receipt before releasing uncertainty; failure stays blocked. An authoritative terminal not-dispatched result invalidates the old review and requires explicit fresh review, never auto-confirm. Receipt expiry without proof leaves uncertainty blocked.
- [ ] **Step 4: Repeat Step 2 plus typecheck.** Existing `outcome-unknown` and text retry copy stays text-specific; image error/status copy never instructs Retry/Resend. No keys or payloads added to storage/public sockets.
- [ ] **Step 5: Commit `feat: add private image follow-up state and recovery`.** Complete the chosen review gate before the next task.

### Task 7: Accessible review/confirmation UI and text-send coordination

**Files:** Create `src/components/ConversationAttachment.tsx`, `.css`, `.test.tsx`, `.integration.test.tsx`; modify `AgentConversation.tsx`/`.test.tsx`, `src/control/useConversation.ts`/`.test.tsx` only for the shared admission guard/conditional draft clearing. Compatibility correction: update only the `ControlAccess` test doubles in `src/components/AgentDetailPanel.runControls.test.tsx`, `AgentDocuments.test.tsx`, and `AgentSchedules.test.tsx` so their real-parent tests can exercise the new hook; do not weaken their existing assertions or add production fallbacks for missing mock exports.

**Interfaces:** `ConversationAttachment` consumes `AttachmentForm` and renders file selection, metadata review, exact warning, acknowledgment and receipt/check controls. Add optional `attachmentBlocked?: () => boolean` to `useConversation` options; both `submit(false)` and `retryPending()` call it at admission. Expose `clearRecordedDraft(submittedMessage: string): void`, which clears text only if it still equals that submission, without pretending a text submission occurred. The parent calls `useConversation` then `useImageAttachments` in stable order, passes text state/pending to the latter, and refreshes an image-guard ref synchronously each render; the text hook's callback reads that ref, not an effect-delayed boolean. Text admission is blocked while an image is selected/reviewed/admitted or its marker is unresolved. Switching modes can drop unconfirmed selection but cannot erase admitted uncertainty; disabled button rendering is not the admission guard.

- [ ] **Step 1: Write `keyboard_reviews_but_never_confirms`, `image_unknown_has_no_text_retry`, `original_review_survives_newer_draft` and `recorded_mode_has_no_image_controls`.** Include confirm double click, acknowledgment default false, removing/changing image, busy follow-up, current target display, blank/command text, disabled flag, permission/unavailable states, pointer/keyboard affordances and focus return. Pin the full warning verbatim from the spec.
  ```ts
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByRole('checkbox')).not.toBeChecked();
  expect(confirmRequests).toHaveLength(0); // Ctrl/Cmd+Enter opens review only
  expect(textSendRequests).toHaveLength(0); // image selection/unknown blocks both send and retry
  expect(screen.queryByRole('button', { name: 'Retry original submission' })).toBeNull(); // image recovery UI
  ```
- [ ] **Step 2: Run `npm test -- src/components/ConversationAttachment.test.tsx src/components/ConversationAttachment.integration.test.tsx src/components/AgentConversation.test.tsx src/control/useConversation.test.tsx`.** Capture meaningful red behavior before UI/coordination edits.
- [ ] **Step 3: Implement the component and narrow guard.** Labels: **Attach image**, **Review image message**, **Send image follow-up**, **Check original submission**. Review explains office-server staging precedes native confirmation, shows full frozen message and target/metadata, and never uses thumbnail/object URLs. Keep 44px targets, status announcements, one drawer scroll flow and focus behavior. New/history/Steer are text-only. Do not turn image acceptance into provider/task success or clear newer text on late receipts.
- [ ] **Step 4: Repeat Step 2 plus typecheck.** Use real `ControlAccessProvider`, `useConversation` and attachment hook in integration tests rather than mocking away their interaction; normal text-only controls/retry remain unchanged when images are absent.
- [ ] **Step 5: Commit `feat: add reviewed single-image conversation follow-ups`.** Complete the chosen review gate before the next task.

### Task 8: Restart proof, production browser, operator guide and release gates

**Files:** Create `server/control/attachmentIntegration.test.ts`, `docs/image-attachments.md`; extend `fixtures/attachments.ts`, `scripts/smoke-package.mjs`, `package.json#files`, `docs/configuration.md`, `docs/task-access-setup.md`, `docs/revamp-status.md`, `CONTRIBUTING.md`. Record owned synthetic browser evidence in this plan; no screenshot/private fixture from a real agent. Only update scoped AGENTS notes if a genuinely new invariant needs durable guidance.

**Interfaces:** `attachmentHost(options)` in the fixture returns `{ url, frames, sendCount, waitForAdmission, releaseReply, close }` and implements signed challenge/hello, target/history reads and controlled native ACK loss/policy changes. Tests launch the actual office child process on an assigned loopback port with owned disposable data; they do not add production test routes or contact the live office. New guide is explicitly an unreleased source feature and is included in the packed artifact without bumping/publishing a version.

- [x] **Step 1: Write `restart_rejects_old_confirm_without_second_native_send`, `restart_of_unconfirmed_review_never_sends` and `package_keeps_attachment_feature_opt_in`.** First prepare/confirm through actual HTTP, have the fixture record admission while dropping the ACK, stop/restart the real child, replay old confirm/receipt and assert native count remains one. A separate lost-preparation-response/restart scenario must remain zero. Check packed guide/default-off startup does not create new identities, connections or data stores.
- [x] **Step 2: Run `npm test -- server/control/attachmentIntegration.test.ts` and relevant package assertions to obtain red evidence before adding fixture/smoke support.** Preserve owned-process cleanup on all exits and keep normal fixture result limits.
- [x] **Step 3: Finish the process fixture/smoke tests and operator docs.** Document configuration/restart opt-in, ordinary write authority only, supported formats/limits, metadata/sharing/retention caveats, no-replay versus text Retry, source/capability denial, and disabling without undoing a dispatched action. Add minimal navigation links, not an installer redesign. Include the new guide in `package.json#files`; do not alter dependency versions or publication state.
- [x] **Step 4: Run full contributor gates on the exact completed source.** Commands: `npm ci`; `npm run typecheck`; `npm test`; `npm run test:coverage`; `npm run build`; `npm run test:package`; `npm audit --omit=dev --audit-level=high`; `npm audit --audit-level=moderate`. Expect exit zero for each and unchanged coverage floors (branches 36, functions 37, lines 41, statements 39). Run Docker build/API/SPA startup as documented in CONTRIBUTING with a unique owned image/container and ephemeral loopback port; verify cleanup. Report environmental blockers rather than silently replacing a gate.
- [x] **Step 5: Qualify the production browser against the signed synthetic host.** Use available browser-testing guidance/tools, no new dependency: 320/390/768/1024/1440px, short landscape and 200% text zoom; actual 44px hit-testing/focus; PNG/JPEG boundaries, review/checkbox/keyboard, delayed File reads, all hide/lock/unmount/target races, typed native denial, lost ACK and Check-only recovery. Inspect screenshots and actual visual results, console, network, browser storage and public socket traffic. Verify no native/public URL, private image/prompt/key or replay; record exact source revision and limitations, not just that screenshots opened. No live upload/task.
- [x] **Step 6: Commit `test: qualify native image follow-up boundaries` and obtain independent whole-branch review.** Fix valid findings with their own red/green evidence; rerun affected/full gates as warranted. Record any unavailable review rather than counting it as clearance. Stop with a local verified branch and concise handoff; ask for push/PR direction if not already authorized. If later authorized, follow exact-head CI/bot adjudication and protected merge workflow without bypass; live activation remains separate.

## Self-review and execution handoff

Plan self-review completed by the coordinator on 2026-11-17, not delegated: authority/limits/validation map to Tasks 1–2; frozen identity, expiration and replay policy to 3–4; private buffering to 5; clearing/uncertainty/accessible review to 6–7; restart, browser, packaging and repository gates to 8. The five Review Focus items have named tests in their owning tasks. Interface review corrected receipt checking to use a retained text digest rather than forbidden message retention, made full-frame serialization explicit, and made the composer guard callable at admission to avoid a render-order gap. Task names/signatures and local documentation links were checked; no feature tests or implementation steps have been executed. Distinguish source qualification, future PR/merge, deployment and package availability; no implementation checkbox may be marked from a plan review alone.

- [x] Task 1: contracts/image/config — `272feef`; focused/types/full 2,585 tests pass, independent task review approved. Baseline focus/noise and development audit remain separately tracked.
- [x] Task 2: native capability/transport — `3fe583c`; 163 focused tests, typecheck and full 2,650 tests pass; independent task review approved. Existing noise/audit remain separate gates.
- [x] Task 3: bounded authority/leases — `ee5214a` + `bb3f364`; initial full 2,673 tests, fix 30 focused tests/types pass; independent scoped review closed all three lifecycle/identity findings.
- [x] Task 4: exact-target service/receipts — `93cce9a` + `0b96256`; initial full 2,779 tests, custody fix 167 focused/types pass; independent scoped review closed resource-bound finding.
- [x] Task 5: authenticated ingress/runtime — `fd04248`; 97 focused, 177 private-route regressions, typecheck/full 2,808 tests pass; independent task review approved.
- [x] Task 6: private hook/uncertainty — `6507960` + `9119a8c`; initial full 2,852 tests, recovery fix 99 focused/types pass; independent scoped review closed both receipt-ordering findings.
- [x] Task 7: accessible composer — `edcf9de` + `c29ce61`; initial full 2,899 tests, focus fix 32 focused/types pass; independent scoped review closed focus-return finding. Inherited initial feature RED unobserved and not claimed.
- [x] Task 8: process/browser/repository qualification and whole-branch review complete.

Status at plan creation: detailed design approved; plan awaiting user review/execution-method confirmation; **no feature code implemented**. Recommended execution is subagent-driven: eight security/reliability boundary tasks justify independent task review, with sequential ownership of shared interfaces. Native execution is the faster alternative, with controller implementation and one independent final whole-branch review.

Execution update: the user approved subagent-driven execution on 2026-11-17. Task 1 is implemented/reviewed; later tasks and final qualification remain pending. Baseline production audit is clean; the full development-tree audit reports the picomatch advisory chain, so merge-readiness is not claimed. No external writes or live actions have been performed.

Final local qualification update (2026-11-24): final fix `5bd032c` closed all three whole-branch review findings with independent scoped re-review. On that source, `npm ci`, typecheck, 2,927 full tests, coverage (88.51% statements, 86.74% branches, 91.31% functions, 91.25% lines), build, package smoke, both npm audits (zero vulnerabilities), and owned Docker build/API/SPA/roster smoke passed. One coverage attempt hit the previously observed intermittent schedule-focus assertion; its isolated 28 tests and a fresh full coverage run passed, and the failed attempt remains recorded. Exact-source signed synthetic browser evidence covers responsive/200% text geometry, real tab hiding, target/review/unknown fences, recorded-run suppression, one-send Check recovery and outbound public socket inspection; a separate owned headed Chrome run confirmed genuine 200% page zoom, readable review/acknowledgment, 44px hit targets and no send. The five exact-source screenshots were visually inspected; no live task/image or user browser profile was used. Browser and gate details, including harness corrections and cleanup, remain in ignored plan scratch. This is local source qualification only; hosted CI, merge, package publication and live activation are distinct future gates.
