# Agent documents preflight hardening

Goal: correct the single late Kody finding on merged PR #353 without weakening source fencing, draft retention or no-replay behavior.

Base: `c74a10cb88b8df28ad47319f334f438b03b4a134`. Original contract: [Agent documents design](../specs/2026-11-17-agent-document-editor-design.md), [operator guide](../../agent-documents.md). Source-only follow-up under the standing review/fix/PR authorization; no live activation, credentials, native grants/writes, deployment, service change, release or publication.

## Finding and bounded correction

Kody completed at 12:04:20 UTC and reported one thread: [pre-dispatch failures misclassified as unknown](https://github.com/SweetSophia/openclaw-pixel-agents/pull/353#discussion_r4599269070). In `useAgentDocuments`, `saving` starts before the management preflight; management failure/invalidation therefore reports possible committed-write uncertainty although no Save request was attempted.

The classification is valid to fix. The draft is already retained, and reload requires explicit discard consent; automatic draft loss is not established. Ticket TTL alone does not establish current source/epoch validity. Do not implement a blind retry/new-operation workaround, silently rebase or revive invalidated Save authority.

### Task 1: distinguish preflight from attempted saves

Files: `src/control/useAgentDocuments.ts`, its tests, `src/components/AgentDocuments.test.tsx` if needed for real-parent copy/consent, and `docs/agent-documents.md`. No server, network-contract or generic access changes are required.

- [ ] Write a failing regression: selected dirty document → explicit Save → management failure before Save request. Assert zero Save attempts, exact retained draft/dirty consent, no misleading document-outcome-unknown error, disabled invalidated Save and no automatic/new-ID retry. Include management parse/failure or preflight invalidation boundaries as warranted.
- [ ] Make the minimal phase-aware classification fix. Reuse existing state where sound; otherwise name attempted dispatch precisely. Only attempted saves may produce uncertain-write guidance. Retain epoch invalidation and explicit fresh review after lost/changed source.
- [ ] Preserve all post-attempt failure/timeout/hidden/reconnect/malformed-ack and undo-to-old-baseline protections, newer-input acknowledgements, ordinary Lock security and document-only denial isolation. Run the covering hook/parent/access/integration suites; record observed RED/GREEN before commit.
- [ ] Clarify the operator guide: known-not-attempted preflight failure differs from post-attempt uncertainty; drafts are retained; source loss still requires fresh review and discard consent. Do not promise safe blind retries or automatic recovery.
- [ ] Run typecheck/full tests and self-review; commit the surgical implementation. Independent task/whole-follow-up review and any scoped fix verification precede push.

## Qualification and protected delivery

Coordinator owns final-head typecheck, tests, coverage, build, installed package, both audits and exact-source Docker; use focused browser evidence only if the changed behavior needs a browser-only check, not a redundant geometry audit. Original UI qualification is historical evidence, not newly executed follow-up browser acceptance. No live probes.

Push a Ready follow-up PR only after independent review; every Ready push gets a full 15-minute window and fresh current-head bot feedback/checks/protection verification. Inspect terminal review results or documented actual operational failures; do not infer approval from a pending check. Normal protected exact-head merge only, then exact merged-main CI/CodeQL. Reply on the original thread with the fix evidence and resolve only when correction is actually merged/verified. General editing/uploads/attachments remain pending.
