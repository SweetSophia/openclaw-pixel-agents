# Native Usage contract fixture

`native-usage-session-instance.json` captures the installed OpenClaw 2026.10.3
`sessions.usage` handler with the exact request used by this service. Its provenance
records the native module and SHA-256 digest. The handler ran against an isolated
temporary HOME/configuration and native SQLite session store containing only a
synthetic session; no agent task, provider call or live Gateway was involved.

The response retains native key/agent/session identity, scope markers, counters and
cache status. Host paths, origin/creator metadata and unrelated aggregates were
omitted. Zero counters are the native empty-store result, not measured live usage.

The handler projects `scope: merged.scope ?? "instance"` for instance grouping.
An instance response need not contain `includedSessionIds`; its explicit scope
provides the proof. `usageService.test.ts` consumes this capture and rejects the
same row after its scope proof is removed. Separate cases reject conflicting or
empty included-session lists even when the row claims instance scope.

## Native retryable connection refusals

The signed adapter regressions also pin OpenClaw 2026.10.3's documented startup
refusal: `UNAVAILABLE`, `retryable: true`, `retryAfterMs: 500`, with
`details.reason: "startup-sidecars"`. The native handler sends it before operator
authentication while startup is pending, then closes with code 1013. Restart
admission closure uses the same retryable error contract. See the installed
`docs/gateway/protocol/handshake.md` startup guidance and
`message-handler-DioDhJgf.mjs` (SHA-256
`e7f74c5062f32b9119bff5b5b49af36af92875ec3203e7289b65bc7b4726953d`).

The office retries that structured transient failure using the same identity,
grant and scopes. Retry hints are validated and capped at the existing 30-second
backoff limit. Raw error messages never determine retry policy; credential and
pairing rejections remain terminal. Tests cover startup recovery, an established
connection's restart, discarded pending reads, cancellation and genuine denials.
