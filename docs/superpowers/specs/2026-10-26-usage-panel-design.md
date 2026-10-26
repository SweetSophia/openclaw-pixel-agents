# Read-only conversation Usage

The user selected Usage on 2026-10-26: model, token breakdown, context information when available, costs with honest labels, and explicit stale/unavailable states. Implementation details below are Codex choices within that scope.

## Approach and scope

Add Usage after Workspace in the existing drawer. Reuse the selected conversation, office key, operator.read connection, private request middleware, and lifecycle-safe polling. A separate global billing dashboard would need different scope/date filters; enriching public collector snapshots would expose private data and lose exact conversation identity. Neither is needed here.

Use optional native `sessions.usage` with `{key,agentId,range:'all',groupBy:'instance',limit:1,includeContextWeight:false}`. The installed public schema and handler support this exact-session query. Verify ownership and session/lifecycle identity before and after it. Require affirmative instance scope or an exact singleton included-session proof; reject a different owner, session ID, key, family aggregate, malformed numeric metrics or oversized response. Unusable optional model/context labels are omitted without discarding valid metrics. An empty report without recorded values is unavailable, not ready. No transcript paths, creator metadata, provider credentials, raw RPC envelopes, model configuration or global totals reach the browser.

Show recorded input/output/cache-read/cache-write/total tokens for this session instance's available history, not the current task or provider invoice. Missing fields stay unknown; explicit zero remains zero. No summing token categories to manufacture an omitted total. Costs use the Gateway's USD summary, labelled estimated/reported; unknown pricing and partial cache state are explicit. Do not calculate prices locally. Retain native computation timestamps separately from the time the office checked the source.

Model and context limit come from the verified conversation row. Its cumulative token count is not a measurement of occupied context. This Gateway does not expose an explicit occupied-context field in that row; display Not reported and no fill percentage. Do not reuse the public roster meter as conversation context.

## Private contract and lifecycle

Create a bounded shared Usage DTO and `POST /api/control/agents/:id/usage`, accepting only the existing exact ControlTarget shape. Keep the method out of mandatory Gateway negotiation so older Gateways retain all existing functionality. The installed `core-method-policy-CcBevufV.mjs` classifies `sessions.usage` as `operator.read` with `advertise:false`; a targeted allowlisted call must therefore work even when omitted from hello features. An INVALID_REQUEST response means this optional query contract is unsupported. Do not probe arbitrary methods or parse raw diagnostic strings. Unsupported usage displays a specific empty state while verified model/context configuration can remain visible.

Use the existing useTaskDetails selection/polling machinery with a Usage mode. While Usage is active, refresh its snapshot every five seconds plus manual Refresh; do not fetch task history or Results. One read per panel in flight. Changing tab, conversation, agent, source lifecycle, key generation, visibility or closing/locking cancels reads; late replies cannot overwrite another selection. Auth/identity failures clear data. Ordinary same-target failures retain the prior snapshot with its original timestamps and a Last known label. No browser storage or public socket additions.

Six accessible tabs retain arrow/Home/End navigation, focus restoration and 44px targets. Use semantic label/value lists with wrapping on mobile and one drawer scroll area. No sends, approvals, model changes, scheduling, publication, dependency upgrades or production configuration changes belong to this feature.

## Verification

Pin unknown versus zero, finite bounds, partial/missing cost and timestamps; exact ownership before/after await; optional method negotiation; and protected-route validation. A controlled Gateway must exercise the real adapter, service and HTTP route. Frontend regressions cover selected-session continuity, no task/history reads on Usage, stale timestamps, auth clearing and cancellation on tab/lock/hidden/selection changes. Inspect desktop/mobile/short-screen behavior in a native browser using synthetic fixtures. Run types, tests/coverage, build, actual package smoke, Docker checks and audits. Use a fresh whole-branch reviewer and inspect current-head bot findings. No real agent task is required; a new npm publication remains a separate action.
