# Recorded run history

User-authorized roadmap task 2 follows the 1.7.0 release preparation. This is a private, read-only extension to the existing Task, Conversation, Results and Usage panels.

## Behavior and acceptance

- Keep **Live / latest task** as the default. A shared **Task / run** selector lists exact run IDs observed in the selected conversation's native history. Selecting one stays sticky across the four tabs; another conversation or a locked/changed access generation clears it.
- Read initial history in pages of 50, at most 200 automatically. **Load earlier runs** adds at most 50 records per action, with a cumulative 2,000-record and 2 MiB window limit. Show the loaded-subset, choice-count and size/record limits. Cache at most eight private windows for 60 seconds, retaining the original observation timestamp.
- A history snapshot is a fixed transcript window. **Refresh run history** starts a fresh tail window while preserving the selected run ID. If that run is outside it, show that its facts are not loaded and allow bounded earlier discovery; never silently follow a different run.
- Historical Task and Conversation show only explicitly run-tagged source records. The native transcript supplies run identities. When advertised, the optional read-scoped `audit.activity.list` method supplies historical terminal metadata. Require a complete, unambiguous V1 agent-run result with exact agent, session key, session ID and run ID; missing session provenance or conflicting executions leaves state unknown. Do not import the current session's outcome, model or child-session relationships. An assistant stop reason is not terminal proof.
- Historical Results queries and file reads use that exact observed run. Keep their caches and metadata/content verification separate from the live/latest scope. A run absent from the authorized transcript window cannot authorize artifact discovery. Historical file intent is explicit; existing live/latest transfer fences remain unchanged.
- Historical Usage explains that the current native `sessions.usage` contract reports conversation-instance totals, not per-run totals. Do not request or relabel those totals for an older run.
- Historical mode has no send/new-conversation/retry controls. Keep the live composer mounted inactive so an unsent draft or uncertain submission is preserved when returning to live mode. Future Stop/Steer controls must receive the same read-only state.

## Source and trust boundaries

The installed OpenClaw 2026.10.3 `chat.history` source exposes `__openclaw.runId` (and compatible top-level `runId`) on transcript records. The existing source-backed projection already consumes this identity. Run discovery does not infer groups from timestamps, prompts, tool names or array position. Display projection continues to strip system messages, reasoning and raw tool payloads.

New run reads use the existing protected server-side Gateway adapter and `operator.read`, without new scopes or public roster/socket fields. `audit.activity.list` is added to the closed native method allowlist only when advertised; its absence does not break history, task access or the connection. The private `/runs` POST validates an exact canonical target and bounded run/cursor/refresh fields. Results accepts only the same exact target plus an optional selected run ID; Usage and sending do not accept a historical selector.

The installed native [ledger contract](https://docs.openclaw.ai/gateway/protocol/ledgers) and V1 schema establish the exact positive outcome mapping: succeeded → Completed, cancelled → Stopped, failed/timed-out/blocked → Failed. A started record alone does not prove current activity. Start/end timestamps come only from matching metadata events. Optional audit failure can retain earlier positively verified facts as last known, with both transcript and audit observation times unchanged. Missing best-effort ledger evidence never proves that a run did not occur. `audit.run.inspect` was considered, but execution-identity collection is separately disabled by default and its run-only results may be ambiguous; it is not required or silently enabled by this feature.

Verify canonical ownership/lifecycle/branch before and after source reads. Bind continuation tokens to the target, selected run, window and source leaf. Reset, deletion, rewind, branch changes and credential loss invalidate proofs and pending work. Temporary source loss may retain last-known facts with their original timestamp; it cannot authorize historical content transfer.

## Verification

Meaningful regressions cover exact-run correlation and missing-run handling; positive/ambiguous/missing terminal provenance; optional audit negotiation without expanded scopes; raw-record and byte bounds; source-leaf/cursor/branch races; source loss versus revoked authority; projection privacy; historical artifact scope and unchanged live transfer fences; strict protected routes; cross-tab selection and inactive-draft retention; late responses after run/session/lock/generation/visibility changes; timeout recovery; and unavailable per-run Usage without conversation-total reads.

Run typecheck, the full suite and coverage, build and actual package startup. Root-coordinated native Chromium checks use the compiled office against a synthetic Gateway, including narrow mobile geometry and accessible controls. No real agent task, live Gateway restart, new grant or production-state mutation is part of qualification.
