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
