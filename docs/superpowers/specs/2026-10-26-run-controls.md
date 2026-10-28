# Exact-run Stop and conversation steering

The user authorized this phase on 2026-10-26. Extend the existing private control
adapter, with no administrator scope, generic RPC endpoint or live test actions.

Stop names a source-verified direct active run in the visibly selected canonical
conversation. Fresh unchanged task reads and final target verification precede
`chat.abort` with the exact run ID; ambiguous, stale, historical, replaced and
unidentified work is unavailable. Confirmation names the run and explains that
its controlled child work may also stop. Native device/run ownership can deny a
Stop despite write access. Admission is labelled requested, never completed;
uncertain outcomes are refreshed without automatic cancellation replay.

The composer retains follow-up as its default and adds an explicit steering mode.
Native `chat.send` with `queueMode: steer` targets this conversation's direct work
at admission, or can start a new turn after it becomes idle. It cannot promise
delivery to an earlier observed run. Do not use deprecated `sessions.steer`, whose
native meaning is interrupt. Both modes retain exact conversation identity,
immutable idempotency key/message/mode on retry, drafts, command exclusions and
`deliver: false`. No external delivery or replay after reconnect is introduced.

Native OpenClaw 2026.10.3 contracts: `docs/gateway/protocol/rpc-session-control.md`;
installed `sessions-DJqMAtE3.mjs` schemas (chat send 2422, abort 2457),
`chat-abort-handler-CPVx8iK0.mjs` (115–228),
`chat-abort-runtime-LqXFjvF0.mjs` (40–70), and
`chat-send-handler-DvXjCaNE.mjs` (895–1151, 4366–4369).

Verify exact target/run races, stale and ambiguous facts, ownership denial,
duplicate clicks, response loss/no replay, capability negotiation, private route
guards, steering/follow-up retry separation, retained drafts, history-mode
disablement and confirmation/focus/keyboard behavior with synthetic fixtures.
