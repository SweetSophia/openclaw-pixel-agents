# Real task details, then conversation and send controls

Status: user-approved on 2026-10-23; implementation-plan review is next. Product implementation has not started.

## Intent and agreed order

The pixel office should become a useful place to work with existing OpenClaw agents. The user selected two deliveries, in this order:

1. A real task-detail panel showing source-backed task information.
2. Conversation and send controls for the selected agent and conversation.

The wider capability list (approvals, run controls, scheduling, model selection, results/files and usage) is a future direction. Those controls are not prerequisites for these two deliveries. Existing room navigation, furniture, agent preferences and the snapshot feed continue to work independently.

## Findings that shape this design

- The office currently aggregates the most recently updated session per agent. Its animation/activity classification is inferred from recency and token counts. It does not establish that a particular task is running or finished.
- One agent can have multiple conversations. The live read-only check found Cylena's Telegram conversation, a separate main conversation, and previous sub-agent sessions.
- Installed OpenClaw 2026.10.3 successfully answered read-only `sessions.list` and `chat.history` requests. A busy session reported `hasActiveRun: true` while omitting `activeRunIds`. History supplied an `inFlightRun.runId`; message metadata also exposed run and message identities. An omitted exact run set is not an empty set.
- The latest 30 records of that conversation contained tool calls and results without the original user request. Pagination is necessary; a missing prompt in one page is not an empty task.
- `chat.history` provides display-normalized messages. Its text, tool activity and terminal facts must still be projected into a bounded office-specific response. No private task text or tool arguments are included in this document or mockup.
- The existing dashboard has origin checks for preference/layout writes, not operator sign-in. Detailed conversations and later command access need an explicit access boundary.

## Approach

Use a server-side Gateway adapter, as proposed in the capability discussion. Keep the existing collector responsible for the office roster; fetch task information on demand through the adapter. The read panel and later send controls share that adapter and exact session identity.

Alternatives considered:

| Approach | Tradeoff |
| --- | --- |
| Backend Gateway connection — proposed | Source-backed history and run facts, one connection, credentials stay on the server, and a direct path to later conversation controls. Requires device pairing and a protected office API. |
| Enrich collector snapshots | Works for remote push-only installations, but duplicates the richer read path, sends private task content even when nobody opens the panel, and still needs a separate command connection later. |
| Browser connects directly to Gateway | Uses Gateway authentication directly, but adds browser-origin, pairing and secure-context requirements to a dashboard currently used through a direct-IP HTTP URL. |

The transport, access-key UX, bounds and initial selection policy below are implementation proposals made by Codex for review, not additional requirements attributed to the user.

## Delivery 1: task-detail panel

### Entry and layout

- Clicking an agent in the office, sidebar or activity list opens the existing modal drawer/bottom sheet. Preserve its focus trap, Escape handling and focus restoration.
- The header identifies the agent. Two accessible tabs, **Task** and **Agent**, keep task information prominent while retaining current agent metadata. Task is initially selected.
- Desktop uses a readable drawer of up to 560px; mobile uses the existing bottom-sheet pattern with one vertical scrolling area. Controls have at least 44px targets; long text wraps without horizontal scrolling.
- A conversation selector shows channel/name, a short identifier and source-backed running/not-running state. The first choice is the roster's exact `sessionKey` if the Gateway lists it. Otherwise select the newest visible non-child conversation; if only children exist, select the newest child. Explain the fallback. Never change a user's selection automatically because another conversation became busier.
- The session list is paginated, initially 25 entries, with **Load more conversations**. Previously selected sessions remain selectable while lists refresh. Child sessions are visibly labelled. A missing or replaced target requires a fresh selection; do not silently retarget it.

### Information shown

1. Conversation identity and freshness: where the task belongs and when OpenClaw last verified the facts.
2. **Task request** when a user message is explicitly correlated to the selected run. Otherwise label the text **Latest recorded request** and show its association as unknown; do not imply it belongs to active work.
3. **Run state** from Gateway facts: Running, Completed, Failed, Stopped, Not running, or Unknown. A historical error is not automatically the current run's state. No active work is not automatically success.
4. Actual start/end/duration when supplied. Do not reuse the roster's time-since-update value as run uptime.
5. Recent recorded activity: tool name, timestamp when present, and observed pending/success/error outcome. Match calls/results by tool-call identity and run identity where available. A missing result means no result recorded, not success.
6. Latest visible assistant response, with a separate **Result** only when a correlated terminal fact establishes a finished run. Assistant `toolUse` turns are not final results.
7. Related child sessions returned with verified parent/control lineage. Label this as the loaded subset if pagination prevents a complete count. A child's error or completion does not determine the parent's status.
8. Existing model/context information under Agent, with the selected conversation's model and context clearly distinguished from the roster aggregate.

The first delivery shows tool names and outcomes, not raw command arguments, full tool output, system messages, private reasoning, credentials or diagnostic payloads. Plain text renders through React text nodes. Unavailable facts have explicit empty states.

### Honest state and identity

- Normalize aggregate session activity separately from task/run status. `hasActiveRun: true` establishes running session work; `false` establishes no direct active run; omission establishes unknown.
- Only correlate exact run IDs obtained from the selected session's history/events or an admitted send. Never pick an arbitrary item from a run-ID array as the current owner. If several runs are active and the source does not identify the displayed run, keep the aggregate state and say exact task state is unavailable.
- Interpret a task's terminal state only from a matching Gateway run/session terminal fact. A failed tool call can coexist with a successful overall run.
- Partition all data by agent ID, canonical session key, session ID, and lifecycle/branch identity where supplied. A reset, deletion/recreation or branch change invalidates the prior task and pending reads, even if the key remains the same.
- Prefer Gateway sampling timestamps and revisions over local request completion order. Responses for a previous selection or lifecycle must not replace the current panel.

The Task tab follows one live-or-latest task; Delivery 1 has no historical run picker. On initial load use the selected session's `inFlightRun.runId` when history identifies its current run. If the Gateway reports no active work, use its canonical `lastRunId` when supplied. Resolve that identity against recorded message/run facts before assigning a prompt or result. If active work has no identified current run, show aggregate Running with **Current task identity unavailable**, and show any older request/result only as previous recorded context. If an idle session has no canonical last-run identity, show the latest recorded request with task state Unknown. Never manufacture a run by grouping nearby timestamps. Follow a newly identified current run within the same conversation and announce the change without moving keyboard focus; do not switch conversations. Historic run browsing can be added later.

### History, freshness and loading

- Fetch the newest 50 history records. If the needed request is absent, seek backwards using the Gateway's own cursor/offset, automatically reading at most 200 records for initial discovery. Keep recent activity visible during discovery.
- If the task text is still outside the loaded window, display **Task request not loaded** and an explicit **Load earlier records** action. Each action reads at most another 50 records; cap cumulative discovery at 2,000 records for that selection and explain the limit. Never synthesize a task description from token counts or a tool command.
- Refresh visible task facts every five seconds while the Task panel is open and the document is visible, plus a manual Refresh. Coalesce duplicate reads, allow one refresh per selected target in flight, and stop on close, lock, hidden page or selection change.
- Gateway change events invalidate bounded in-memory caches. They are not forwarded over the public office socket. Cache at most 100 normalized snapshots, each at most 256 KiB, expiring after 60 seconds; successful reads can be reused for two seconds.
- A failed refresh retains the last successful same-target snapshot with a **Last known — connection unavailable** label and its original timestamp. It does not turn running work into idle/completed. Initial failures show Retry, not a fabricated task.
- Empty lists, denied history, unsupported Gateway methods, partial records, unknown status and removed sessions have distinct states. A disconnected task source does not change the office roster's connection badge.

## Backend and access boundary

### Opt-in Gateway adapter

- `OPENCLAW_GATEWAY_URL` enables the integration; unset leaves existing office operation intact and the task panel explains that task access is not connected.
- Use Node's WebSocket support and the documented Gateway protocol, with runtime validation of the handshake and the small method/event subset used here. No dependency on private compiled OpenClaw modules or reserved internal helper identities.
- Use a distinct paired operator device with a persistent signing identity and scoped device token stored under a private `DATA_DIR/control/` directory (directory 0700, files 0600). Bootstrap credentials, if required, come from `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD` in server configuration; never from browser requests or URLs.
- Request `operator.read` for Delivery 1. Treat pairing/scope rejection as a setup state, not a reason to weaken Gateway policy. Delivery 2 additionally needs `operator.write`; never request `operator.admin` for these features.
- Validate the configured endpoint: encrypted remote connection, or plain WebSocket only to loopback. No browser-controlled Gateway URLs. Do not change Gateway binding, origin policy, global models, authentication mode, or the existing collector setup.
- Negotiate supported protocol/features/scopes on every reconnect. Read requests time out after five seconds, with at most eight pending RPCs. Use jittered reconnect backoff capped at 30 seconds; stop credential/pairing failures from becoming a rapid retry loop. Bound message decoding and reject malformed/oversized payloads; normalize only allowlisted fields.

### Protected office endpoints

- Require a separately configured `PIXEL_CONTROL_TOKEN` for every task/history read and later send. It is separate from the ingest secret and Gateway credentials. Missing configuration disables task access.
- First use offers **Unlock task details** with a password-style access-key field. Keep the key in tab memory only, clear it on Lock, clear private caches on lock/auth failure, and redact it from logs. Page reload requires unlocking again. No account system or persistent browser credential store in these deliveries.
- Send the key in an Authorization header, never a query parameter. Compare derived fixed-size digests following the existing ingest-auth pattern. Use one private operator access level in this first version; this is not a multi-user permission system.
- Put policy and endpoints in dedicated server modules mounted by `server/index.ts`. Keep existing origin checks for all mutating methods, including the read-only POST below, and apply a bounded control-request rate limit before expensive Gateway work.
- Proposed read contract: `GET /api/control/status` reports task-read availability only; `GET /api/control/agents/:id/sessions` lists normalized visible session choices; `POST /api/control/agents/:id/task` reads a selected target from a validated body containing session key, observed session ID and optional history cursor. The POST keeps conversation identifiers out of request URLs. No generic RPC proxy is exposed.
- Allow only configured registry agents. Verify session membership against canonical Gateway results before every read; reject agent/key/observed-ID mismatches. Revalidate child lineage before exposing a related child. Bound IDs, cursor sizes, pagination, request bodies, strings, activity arrays and the total response.
- Server responses contain normalized facts and bounded display text only. Do not expose transcript filesystem paths, delivery destinations, raw RPC envelopes or auth/diagnostic objects. Set private responses to `Cache-Control: no-store`; do not persist transcripts or broadcast them through `agents:update`.
- Keep task-source state and the frontend hook separate from `useAgentStore`, its mutation counters and the shared public socket cache. No changes to `AgentState`, collector payloads or layout persistence are needed.

### Browser transport

Task access normally requires HTTPS, with loopback HTTP allowed for local development. The user's existing direct-IP office URL travels over Tailscale's encrypted connection; preserve that working route through an explicit deployment option, `CONTROL_ALLOW_TAILNET_HTTP=true`. This exception is restricted to direct connections: the accepted socket's local address must belong to the host's `tailscale0` interface, and its peer must be a Tailscale IPv4/IPv6 address. Forwarded headers cannot establish this exception, and ordinary LAN/public HTTP requests remain denied even with a valid control key. Evaluate this transport policy before returning task data or accepting the key, including reads. Reverse-proxy HTTPS is accepted only through an explicitly trusted proxy using the existing trust configuration. Document the private-tailnet exception as a deployment choice; it is not enabled by default or inferred merely because a hostname contains `tailscale`.

## Delivery 2: conversation and send controls

This delivery follows a reviewed, verified task-detail release. It reuses the exact target selection, Gateway connection and operator access boundary above.

- Add a **Conversation** tab with bounded, paginated display-normalized human/assistant messages and live response updates. Keep private reasoning, system messages and raw tool payloads out of this view.
- A text-only composer targets the visibly selected conversation. Provide explicit **New conversation** for the selected agent; do not reset or repurpose an existing task to start one. Attachments, file editing, model changes, Stop and Steer are subsequent features.
- Keep drafts in memory keyed by exact target. Preserve them on rejected sends, reconnects and target switches. A replaced target cannot inherit a draft without an explicit user choice.
- Use an explicit Send action; Enter inserts a newline and Ctrl/Cmd+Enter sends. Disable sending while locked, unsupported, not authorized, or disconnected. Respect Gateway write capability and the target's send-disabled reason; preserve the draft with the reason.
- Default busy-session sends are follow-ups, labelled **Send follow-up** when running. They queue after current work; they do not interrupt it. Do not auto-deliver replies to Telegram or another external channel. Validate the documented non-delivery request mode before enabling channel-backed targets; expose unsupported targets as unavailable rather than guessing delivery behavior.
- Limit a submitted text prompt to 8,000 characters. All Gateway methods and parameters remain server allowlisted. Apply stricter send rate limits and never allow a client to submit a raw RPC method, agent executable or Gateway address.
- Give every manual submission a stable idempotency key. Forward that key through the Gateway's supported send contract and retain it across a retry. Sending, admission, transcript persistence and final completion are separate states: an accepted run is not a completed task, and a missing receipt is not a failed send.
- If the network drops after submission, show **Delivery not yet confirmed**, keep the draft and original key, reconcile by source message/submission identity, and offer Retry with that same key. Never replay automatically or deduplicate by matching text. Define deterministic session creation identity for New conversation so an uncertain retry cannot create another conversation.
- Add a separate authenticated Socket.IO `/control` namespace for conversation updates using the installed Socket.IO dependencies. Authenticate each connection, verify origin and target membership, scope subscriptions to the exact target/lifecycle, and emit normalized events only to authorized subscribers. Lock, credential change and session replacement dispose subscriptions and private caches. Keep the public socket unchanged.

## Boundaries and builder choices

These deliveries do not implement approvals, stopping/steering, scheduling, model selection, workspace editing, external-channel delivery, multi-user accounts or a universal pause/resume facility. Completion percentages are not inferred. Existing in-office visibility controls remain visualization preferences.

The builder may settle internal filenames, TypeScript names, the exact list cursor encoding, cache implementation and visual spacing within this behavior. Source capabilities, access controls, target identity, privacy limits, delivery order and send reconciliation are part of the design and may not be silently reduced. If the installed Gateway lacks a required field, surface unavailability and document it rather than falling back to animation heuristics.

## Verification and rollout evidence

- Use synthetic Gateway fixtures, never checked-in real prompts/transcripts. Exercise real framing/handshake and application routing while mocking only external transport/browser boundaries.
- Verify unknown versus false/empty run facts, exact-run correlation, failed tools within successful runs, missing prompts beyond the first history page, bounded pagination, truncation, branch/reset/session replacement, stale/out-of-order reads, and source loss without a false terminal state.
- Verify unauthorized reads/sends, origin rejection, agent/session mismatch, malformed and oversized payloads, no task leakage over the public socket, no secrets in responses/logs and no private browser persistence.
- In the UI, verify session selection during refresh, tab/focus behavior, close/lock teardown, wrapping and reachable 44px controls. For Delivery 2 also verify double-clicks, unknown send outcomes, same-key retries, retained drafts, busy-session follow-ups and explicit new conversations with no external channel dispatch.
- Run repository typecheck, coverage, build and both dependency audits. Validate in Chromium at 320/390/768/1024/1440px and a short landscape viewport. Include live read-only checks against the operator's Gateway; sending tests use a controlled fixture and never send a task to a real agent automatically.
- Preserve current live layout/preferences before deployment. Configure task access separately and verify the original collector, room navigation and canvas controls remain healthy. Roll back feature artifacts/configuration without restoring an older user layout.

## References

- [Gateway session control](https://docs.openclaw.ai/gateway/protocol/rpc-session-control)
- [Session bootstrap and events](https://docs.openclaw.ai/gateway/protocol/rpc-bootstrap-and-events)
- [Handshake and roles](https://docs.openclaw.ai/gateway/protocol/handshake)
- [Device authentication](https://docs.openclaw.ai/gateway/protocol/auth)
- Local source: `src/components/AgentDetailPanel.tsx`, `src/hooks/useModalFocus.ts`, `src/hooks/useAgentStore.ts`, `shared/types.ts`, `server/index.ts`.

Independent builder review completed on 2026-10-23. Its two material questions (browser transport and initial run selection) are resolved above; the follow-up found nothing important left unanswered.

User approved the presented design/mockup on 2026-10-23 with “this looks awesome!” in response to the implementation-design review. The implementation plan is next. The browser mockup remains illustrative and does not send tasks.
