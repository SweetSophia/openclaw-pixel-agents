# Native per-agent scheduling

Date: 2026-11-10

Status: approach accepted; written design awaiting approval. This document does not authorize implementation, live pairing, new live grants, or real scheduled tasks.

## Purpose and chosen approach

Deliver task 6 of the [phase-two revamp plan](../plans/2026-10-26-revamp-phase-two.md): inspect and manage native OpenClaw schedules for a configured agent without editing source or maintaining a second scheduler.

The selected approach is a separate, explicitly enabled scheduling connection with its own device identity and pairing. The ordinary Task/Conversation connection retains its existing scopes and behavior. A read-only-first delivery was considered; the user accepted the separate-authority approach instead.

This is not a generic Gateway console, OS cron integration, or browser-to-Gateway proxy. Workspace editing and attachments remain the next independent delivery.

## Authority and trust boundary

The inspected native build requires `operator.read` for `cron.list`/`cron.get` and `operator.admin` for `cron.add`/`cron.update`. It does not expose the narrower `operator.cron` scope advertised by newer documentation. Do not assume that scope is available on this host.

- The existing ordinary connection gains only optional, closed `cron.list` and `cron.get` read adapters. Lack of those methods disables schedules, not other controls.
- A separate scheduling device requests read/admin authority only after explicit operator opt-in and pairing. Its closed application method list is exactly `cron.list`, `cron.get`, `cron.add`, and `cron.update`.
- Never lend that connection to conversation, models, approvals, Stop/Steer, workspace, artifacts, or generic RPC routes. Preserve the model-selection guard against unexpectedly broad ordinary grants.
- A local method allowlist limits this application's behavior; it does **not** cryptographically narrow a native admin credential. A compromised scheduling identity can have broader Gateway authority. Protect and revoke it independently.
- Reuse the existing validated Gateway URL, signed protocol-4 device handshake, transport checks, private identity permissions, REST authentication, Origin checks, and mutation guards. Do not add forwarded-header trust or broaden the Tailnet exception.
- This remains a single trusted office-key application, not per-user RBAC. The UI must explain the scheduling grant before showing pairing instructions.

Proposed configuration is `CONTROL_SCHEDULES_MANAGE_ENABLED=false` by default. When enabled, use a separate identity beneath `DATA_DIR/control-schedules/` and separate temporary bootstrap credentials named `OPENCLAW_SCHEDULES_GATEWAY_TOKEN` / `OPENCLAW_SCHEDULES_GATEWAY_PASSWORD`. Never borrow ordinary bootstrap credentials or automatically request an upgraded grant. Document removing bootstrap credentials after pairing.

With management disabled, create no scheduling identity and make no management connection. With it enabled, establish that connection lazily after an authenticated schedules visit. Pairing remains an explicit operator action; missing/revoked pairing produces a read-only state, not automatic re-pairing. Dispose both connections when the HTTP server closes, including tests that never invoke `startServer()`.

Browsing requires the ordinary reader to be ready. Management additionally requires the separate connection to be ready, correctly scoped, and connected to the same validated endpoint. Its fresh preflight reads use its own `cron.get`; it is not a fallback reader for unrelated controls. Display the two connection states separately.

## Agent ownership and supported jobs

The configured roster is the only agent allowlist. Agent IDs remain literal and case-sensitive. Native ID normalization must never silently retarget an action: if exact native ownership cannot be established for a configured ID, scheduling is unavailable for that ID with an explanation.

Only expose a job in an agent pane when its explicit native `agentId` exactly matches the selected configured agent. Any returned `effectiveAgentId` and `owner.agentId` must agree. Omit foreign, contradictory, default/inferred-owner, and session/account-owned jobs whose agent-wide ownership cannot be proved. Never infer ownership from a name, prompt, session substring, or declaration-key prefix.

Compatible jobs have an isolated session target, an `agentTurn` message payload, an elapsed interval or supported five-field cron schedule, no external delivery, no failure alerts, and no unsupported behavior overrides. A normal edit changes only the documented fields; do not sanitize and rewrite an unsupported job into this subset.

Owned but unsupported jobs may appear as minimal read-only rows (name, schedule kind, enabled state, reason). Do not forward raw scripts, arbitrary payload fields, or tool/runtime configuration. System-owned declaration namespaces (`heartbeat-task:`, `heartbeat:`, `skill-collection-review:` in the inspected build) are always read-only. Compatible jobs created outside Pixel Agents can be edited if ownership and revision are verified; creation must never adopt somebody else's declaration key.

Manage eligibility is a closed, tested projection of the native contract, not a blacklist of a few dangerous fields. Unknown fields that affect execution, owner/session binding, scripts, triggers, pacing, tool/model/runtime overrides, delivery, or lifecycle make the job read-only. Harmless native metadata and runtime feedback can be displayed/projected without becoming editable.

## User experience

Add an agent-scoped **Schedules** tab to the agent detail panel. It does not require an existing conversation. It shows native enabled state, target agent, interval or cron/timezone, prompt for compatible jobs, verified revision, and source-provided next/last-run facts when present. Truncation, stale data, unsupported methods, pairing requirements, and management-disabled state are explicit.

Historical conversation mode may show current agent schedules, clearly labeled **current schedules; read-only while viewing history**. Return to live mode before any mutation. Switching tabs must preserve unrelated conversation/model drafts.

The first delivery offers:

1. List and inspect owned schedules.
2. Create a disabled schedule, review the native result, then separately enable it.
3. Edit a compatible job's name, prompt, and schedule.
4. Enable or pause a compatible job through a separate confirmation.

No Delete or Run Now in this delivery. The inspected remove request has no caller-supplied revision precondition, so a read-then-delete flow cannot offer the same concurrency protection as edits. Run Now is a distinct execution authority and recovery problem. Also exclude one-shot dates, streams, scripts, system events, arbitrary delivery targets, and custom execution overrides.

Before submission, a confirmation shows the exact agent, action, job identity where applicable, current enabled state, resulting schedule/timezone, and prompt. Editing an enabled job explicitly warns that future runs will use the new definition. Pause means prevent future scheduling; it does not promise to stop an already running task. A schedule acknowledgement is not evidence of a run or task completion.

Keep form content in tab memory, not localStorage or URLs. Lock/credential-generation changes clear private reads and drafts; tab closure does not trigger a mutation. Hide/unmount cancels reads and fences late responses. A dispatched mutation whose response is lost remains uncertain and must not be replayed because the user revisits the tab.

Keyboard operation, associated labels, focus management, readable status announcements, and touch-sized actions are required. The panel must work in the existing narrow-screen flow without changing canvas geometry or persisting navigation changes.

## Form and native request contract

Application bounds (enforced server-side as well as in the UI):

- Name: trimmed, nonempty, at most 128 characters; reject control characters and malformed Unicode.
- Prompt: nonempty after whitespace checking, at most 16 KiB UTF-8, well-formed Unicode; preserve intentional newlines. No application-level command interpolation.
- Interval: integer milliseconds from one minute through 365 days. Explain that an interval is elapsed time, not a local-calendar day.
- Cron: exactly five fields, at most 128 characters, with an explicit valid IANA timezone (`UTC` allowed). Native validation is authoritative for expression semantics. Do not add a second scheduler or dependency merely to fabricate previews.
- Opaque native job IDs and declaration keys: nonblank bounded strings, at most 200 characters; reject controls. Never truncate or normalize an identity into validity. Revisions are opaque nonempty strings of at most 128 characters.

New jobs are server-constructed with explicit selected `agentId`, `owner: { agentId }`, a server-generated namespaced declaration key, `sessionTarget: "isolated"`, `wakeMode: "now"`, `enabled: false`, `deleteAfterRun: false`, `payload: { kind: "agentTurn", message }`, `delivery: { mode: "none" }`, and `failureAlert: false`. Only name and schedule are otherwise supplied. Do not accept arbitrary native request objects from the browser.

`delivery: none` disables automatic scheduler announcements; it does **not** sandbox the agent or prevent its ordinary tools from taking external actions. Show that caveat when enabling. Disabled jobs need not have a next-run timestamp; do not invent one. Native cron/DST behavior is the contract, not a browser approximation.

An edit sends only name, payload message, and supported schedule changes, preserving job identity and enabled state. Enable/Pause sends only enabled state. Both require a fresh management-side ownership/compatibility preflight and the exact `expectedConfigRevision` from the reviewed definition. Preserve unrelated metadata; never replace a native job with a locally reconstructed object.

## Concurrency, uncertain outcomes, and recovery

### Edits, enable, and pause

Native `cron.update` checks `expectedConfigRevision` under its mutation lock. This compare-and-swap boundary is mandatory; a locally cached revision or an application read-then-write check alone is insufficient. A revision conflict refreshes the displayed definition, retains the draft, and requires renewed review. Never silently rebase or retry a mutation.

Bind confirmation to office credential generation, selected agent, native job ID/revision, management connection epoch/endpoint, and draft generation. Changing any invalidates confirmation. Recheck actual management readiness and grants at dispatch. Bound concurrent work and freeze the operation ID/request so duplicate browser submissions cannot become distinct operations.

On timeout, disconnect, cancellation, or ambiguous failure after dispatch, mark the action uncertain. Read-only reconciliation can show the current job, but matching current values are not proof of which caller committed them. Do not report failure merely because the response was lost or replay automatically after reconnection. Proven pre-dispatch failures may be labeled not sent; native errors count as definitive non-commit only when the inspected contract establishes that fact.

### Creation

The native declaration-key form of `cron.add` is convergence/upsert, **not exactly-once creation**. Replaying it can overwrite a job somebody edited after the first request. Therefore it must never be used as an automatic retry mechanism.

Before dispatch, durably reserve a server-generated declaration key and operation ID in a private journal, bound to the office installation, selected agent, canonical request digest, and Gateway endpoint/device identity. Persist only recovery metadata and digests, never prompt text, tokens, or complete native payloads. A reused operation ID with a different body is a conflict. Return the existing operation state for repeated identical submissions, not another `cron.add`.

The journal is required for creation, including across restart. Use atomic replacement and durability barriers, private directory/file modes (0700/0600), symlink refusal, and a single-writer process lock. Bound it at 500 records; fail closed for creation on corruption, lock contention, capacity, or failed durable reservation while keeping unrelated controls and safe reads working. Do not evict unresolved entries. Retain records for this first delivery rather than inventing unsafe time-based expiry; explain operator maintenance when full.

Before every first dispatch, persist a state that cannot later be mistaken for safely retryable if the process crashes between send and recording its result. Consequently a crash before the actual send can conservatively leave an uncertain reservation. Never automatically turn such an entry back into an unsent creation.

After uncertainty, reconcile only with bounded `cron.list`/`cron.get` reads for the exact declaration key and verified owner/endpoint binding. A matching job establishes that a declaration is observed; a changed definition requires review and must not be restored by upsert. Missing results, partial scans, and an empty page do not prove non-creation. Preserve unresolved state across restart. Do not auto-generate a new ID to retry the same intent.

Block another creation with the same agent/request digest while its reservation is unresolved. Show pending recovery metadata after reload without retaining its prompt. Unrelated new intents can proceed. If read-only reconciliation finds the job, link to it and require ordinary revision-checked edits rather than re-creation. If it cannot be reconciled, explain that the operator must inspect native schedules; there is no force-retry/reset control in this delivery.

## Architecture and bounded APIs

Keep `server/index.ts` as wiring. Proposed responsibilities, with precise filenames left to the builder:

- `shared/controlSchedules.ts`: closed private REST DTOs, supported schedule union, read-only reasons, operation/recovery states. Do not add private payloads to the public agent contract or Socket.IO broadcasts.
- `server/control/scheduleConfig.ts`: opt-in configuration and separate identity paths.
- `server/control/scheduleProjection.ts`: strict ownership, native response validation, compatibility and presentation projection.
- `server/control/scheduleJournal.ts`: durable creation reservation and recovery metadata.
- `server/control/scheduleService.ts`: bounded reads, management preflight, CAS mutations, reconciliation and lifecycle disposal.
- Extend the existing Gateway client through explicit, separately selected closed method profiles; never expose an arbitrary method/params caller to REST.
- Private routes under `/api/control/agents/:agentId/schedules`, with operation status beneath the same private boundary; reuse existing office authentication, Origin checks, request-size bounds and mutation rate limits.
- `src/control/useSchedules.ts` and `src/components/AgentSchedules.tsx`: tab lifecycle, draft/confirmation fencing, private operations and accessible presentation.

Use bounded native pagination: at most 50 rows per request, 200 automatically loaded, 2,000 cumulatively per user browse/recovery attempt. Explicitly report further results/truncation. Filtering ownership cannot turn a partial native scan into evidence that no matching job exists. Bound Gateway concurrency and deadlines using the existing client conventions; do not busy-poll or subscribe to unbounded history.

Polling/read refresh occurs only while unlocked and visible, with cancellation and stale-response fences. Keep operation recovery metadata on the server across UI closure. Logs contain correlation IDs, action/result classes, and bounded identifiers, not prompts, credentials, or raw Gateway frames. No new production dependency is planned.

## Verification and acceptance

Implementation must prove the following before a merge recommendation:

| Boundary | Required evidence |
| --- | --- |
| Authority | Signed fake-Gateway tests for separate identities, exact scopes/method profiles, default opt-out/no management I/O, revoked pairing, ordinary model/send invariants, and disposal on HTTP close. |
| Ownership | Custom IDs, canonical mismatch, foreign/default/session/account ownership, contradictory owner fields, reserved declarations, unknown execution fields, malformed native results and partial pages. |
| Mutation | Forced disabled/no-announcement creation; server-only native fields; fresh preflight; native revision conflict/race; exact enable/pause patch; no remove/run methods or raw RPC route. |
| Recovery | Dropped add/update replies, reconnect and process restart; no second add; reservation before dispatch; changed declaration; journal corruption/full/symlink/second writer/durability failure; partial scans never interpreted as absence. |
| Privacy | Existing office key/Origin/transport gates, lock/generation clearing, no public agent/socket leaks, no prompt in journal/log/URL/storage, malformed bodies/prototype keys and bounded requests. |
| Browser | Real-browser keyboard and narrow-screen inspection; historical read-only mode; stale/late responses, draft preservation, confirmation invalidation, disabled-first then explicit enable, uncertain-state recovery. Use a synthetic Gateway, not real tasks. |
| Repository | Supported Node version; clean install when implementation starts; typecheck, tests, coverage floors, production build, packaged installation/startup and Docker smoke, both audit gates, CI and review comments. No lowered gates. |

Keep source, live-host qualification, and published-package evidence separate. Synthetic tests can prove protocol behavior, not live pairing or actual task execution. Neither this design nor its later implementation authorizes new live grants, production schedules, deployment, publication, or unrelated dependency upgrades.

## Contract evidence and refresh requirement

Inspected read-only on 2026-11-10: repository main `27baa909151add9fe54782753d01f7a33233992e`; installed OpenClaw package reports `2026.10.3`. Bundle filenames and version are observations of this host, not a portable compatibility promise.

Native evidence under the installed package's `dist/`:

- `core-method-policy-CcBevufV.mjs`, method policy around lines 1523–1567: read versus admin scopes.
- `src-l2dWvEsN.mjs`, cron schemas around lines 3752–3777 and 4303–4363: isolated target, wake modes, revision bounds, add/update/remove contracts.
- `cron-Dt6vafmd.mjs`, handlers around lines 1464–1572 and 1671–1718: declaration-scoped add, update precondition under the native lock, remove without a caller revision parameter.
- `service-DV6kx_EF.mjs`, native add around lines 4490–4515: an existing declaration is updated, not a harmless create replay.
- `job-read-view-CgKmbr9p.mjs`: native read revisions and imperative/declarative add response shapes.
- `system-owned-declaration-CIFRO5mv.mjs`: reserved declaration namespaces.

SHA-256 fingerprints of the primary inspected contract files:

```text
cc47e5fa54d0460e022cc966ce59bf50de7ffe2876cba0f49bf9f89a60f462c2  core-method-policy-CcBevufV.mjs
d5ad6564ace5e2bfa36c71b8b8d93ea95d4b87c46d02a817a70eac07294b7974  src-l2dWvEsN.mjs
60c5d02486a53caf61001015ef1894e4d1199d34ec8d1c23ec5bc27ea7068b23  cron-Dt6vafmd.mjs
c68f555ec716b43bf61b63aa97ef5dace6ff41d4b31f3e89496379d6eedbe7bc  job-read-view-CgKmbr9p.mjs
```

Reinspect the native contract and current main before implementation. If the supported host lacks these safety capabilities, degrade to read-only and report the incompatibility; never emulate CAS locally or widen ordinary grants. A later narrower scheduling scope can be evaluated separately rather than silently substituted.

The old unmerged `feat/schedules` draft predates recent control and roster work. It is prior art only, not approved implementation or passing evidence. Do not cherry-pick it wholesale.

## Handoff

After approval of this written design, produce an incremental implementation plan with tests before behavior changes. Builder discretion covers internal names, component layout and ordinary implementation details, not the permission boundary, ownership rules, disabled-first workflow, native CAS, recovery/no-replay guarantees, or exclusions above.
