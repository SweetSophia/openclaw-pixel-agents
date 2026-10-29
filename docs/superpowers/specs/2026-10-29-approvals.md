# Private conversation approvals

Implements delivery 4 of the user-authorized phase-two roadmap. Build on the existing private task boundary, not the public roster/collector. Preserve current read/write/Stop/Steer and historical-run behavior. The earlier `feat/approvals` worktree is reference evidence only, not a merge base.

## Native contract and authority

The installed OpenClaw 2026.10.3 schemas and handlers expose `sessions.messages.subscribe` with `includeApprovals: true`, distinct `subscriptionId`, sanitized pending `approvalReplay`, `session.approval` transitions, `approval.get`, and `approval.resolve`. Approval review requires a paired device with `operator.approvals` and native record reviewer binding. Existing `operator.read`/`operator.write` grants do not imply approval authority.

Add explicit `CONTROL_APPROVALS_ENABLED=true` opt-in. With it disabled, existing scope requests remain unchanged. With it enabled, request only the additional approvals scope; do not request administrator, silently upgrade stored grants, copy identity, change the running Gateway, or bypass reviewer bindings. Missing approvals scope/methods/binding must be explained locally without locking unrelated private reads. Separate negotiated approval capability from sending and Stop.

## Discovery and identity

Discover only the selected canonical conversation's authorized pending audience with an ephemeral observer. Validate target before and after discovery, merge events racing replay without resurrecting terminal records, and unsubscribe the exact observer on every exit. Bound replay to 1,000 items, event buffer to 100, visible page to 25, remembered membership to 200 entries with 60-second lifetime, concurrent reads to four, and response bytes to the existing control limit. Overflow or malformed data must fail closed, never silently produce an incomplete decision-relevant record.

Only an exact full ID observed in that conversation audience may be inspected or resolved. Native approval snapshots lack exact run/session-lifecycle markers; verify audience separately and label child-source approvals honestly rather than manufacturing run association. Historical selection cannot read actionable approvals or mutate them. Source invalidation clears observations.

## Decisions and uncertainty

Offer only native-supported `allow-once` and `deny` decisions for exec/plugin/system-agent approvals; no standing grants, reviewer override, global list/history, generic RPC, raw policy envelope or external link activation. Render only bounded reviewer-safe presentation as text, including decision-relevant warnings, target/blast-radius facts, expiry, kind and source attribution.

An explicit confirmation binds immutable canonical target, full approval ID, kind, decision and the inspected presentation. Refresh current audience and exact record, check pending state, expiry and unchanged decision-relevant content, and finally revalidate target and authority before calling native resolve. Changed context invalidates confirmation synchronously, including before passive effects. Duplicate clicks/in-flight operations cannot dispatch twice. Preserve native first-answer truth: `applied: false` is not this operator's success, and expiry/concurrent resolution must be shown accurately.

Unknown outcomes never automatically replay a decision. Keep a bounded process-local attempted-operation ledger (at most 1,000 identities, fail closed at capacity) so an uncertain attempted decision cannot be resent. An explicit read may reconcile authoritative terminal state; pending alone does not establish that a lost native decision failed. Do not claim durable deduplication across process restart. Rate-limit decisions to ten new operations/minute and bound native response validation.

## Client lifecycle and evidence

Use the existing office key in tab memory. Poll only while visible, unlocked and on the selected live conversation; cancel reads and clear private display on Lock, close, hidden page, agent/conversation/lifecycle changes. Stale display retains its original timestamp and disables decisions. Confirmation is named, Cancel-first, Escape-safe, restores focus, and remains usable on phone and short windows. No approval payload enters public sockets, storage or logs.

Verify with synthetic protocol/service/authenticated HTTP/real-hook UI fixtures, including replay races, cross-target IDs, unsupported authority, expiry, first-answer races, unchanged-presentation fencing, unknown/no-replay, close/abort, duplicate clicks and history suppression. Browser acceptance is synthetic only. Run full types/tests/coverage/build/package/audits/Docker gates, independent task/final reviews, the full 15-minute final-push window, protected PR checks and exact post-merge main CI/CodeQL. No real approval resolution, task send, permission change, deployment or npm publication is part of this delivery.

Source evidence: installed `approval-result-validators-BrtTovHw.mjs`, `approval-x4PrwwCI.mjs`, `operator-approval-authorization-BCjW3avN.mjs`, and `sessions-subscriptions-Qi7MsM2n.mjs`. Hash-named module paths are installation-specific; verify behavior, not filenames.
