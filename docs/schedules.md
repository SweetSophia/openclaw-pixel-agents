# Native agent schedules

The agent **Schedules** tab browses native OpenClaw schedules without selecting a conversation. Management is separate and default-off: create a disabled schedule, inspect it, then explicitly enable it. Pixel Agents does not run a second scheduler.

Availability: requires **1.8.0 or newer**, or a source build containing [PR #349](https://github.com/SweetSophia/openclaw-pixel-agents/pull/349); 1.7.0 does not include scheduling. A source merge or release-preparation PR does not publish to npm. Synthetic qualification cannot establish real pairing or task execution.

## Enable management deliberately

First configure [private task access](task-access-setup.md) with a dedicated ordinary device and office key. Browsing uses its existing `operator.read` grant. Missing optional scheduler methods do not disable unrelated controls.

The inspected native contract requires `operator.admin` for schedule writes, not a narrower scheduling grant. The scheduling device is independent of the Task/Conversation device. Its local allowlist is exactly `cron.list`, `cron.get`, `cron.add`, and `cron.update`, but does **not** cryptographically restrict the broader administrator credential. Protect and revoke the scheduling device independently in Gateway administration. All office-key holders are trusted users; this is not per-user RBAC.

1. Preserve a private persistent `DATA_DIR`. Set `CONTROL_SCHEDULES_MANAGE_ENABLED=true` in the server environment and restart the office. Keep the existing validated `OPENCLAW_GATEWAY_URL` and `PIXEL_CONTROL_TOKEN`.
2. For initial pairing only, supply the credential matching the Gateway auth mode as `OPENCLAW_SCHEDULES_GATEWAY_TOKEN` or `OPENCLAW_SCHEDULES_GATEWAY_PASSWORD`. The office never borrows ordinary bootstrap credentials or upgrades its grant.
3. Unlock and visit an agent's **Schedules** tab. Only this authenticated visit starts the management connection. Read source and management readiness are displayed independently.
4. Inspect pending devices with `openclaw devices list`. Verify this office's separate scheduling identity and intended `operator.read`/`operator.admin` request before explicitly approving that request with `openclaw devices approve <request-id>`. Approval is an operator decision, never a browser or wizard action. Do not approve an unrelated ordinary device for admin.
5. Restart if needed to reconnect after approval. Once the separate device token is saved, remove the temporary scheduling bootstrap credential and restart again. Preserve `DATA_DIR/control-schedules/`; never commit or expose its identity/grant.

With management disabled or omitted, no management identity/connection is created, even if scheduling credentials are present. Setting the flag false and restarting disables this office's management connection, but does not revoke its native grant or pause existing schedules. Revoke the separate device when retiring it. Missing/revoked pairing remains read-only; there is no automatic re-pairing or escalation.

Remote access retains encrypted transport, Origin and office-key checks. The explicit direct-Tailnet exception uses actual socket addresses, not forwarded headers. Never put Gateway credentials in browser fields, URLs, collectors or public sockets.

## Create, review, then enable

Choose the exact configured agent. IDs remain literal and case-sensitive; an ID the native scheduler would normalize to another identity cannot be managed here. Closing the office or removing/renaming a roster entry does **not** pause/delete native schedules. Inspect their declarations natively before changing ownership.

Select **New schedule**, enter a name/prompt and choose:

- **Interval:** one minute through 365 days, entered in seconds. This is elapsed time, not a local-calendar day: a 24-hour interval need not keep the same wall-clock hour through DST. Changing an interval can reanchor native timing.
- **Five-field cron:** at most 128 characters with an explicit IANA timezone, such as `Europe/Berlin` or `UTC`. Native validation, DST behavior and default staggering are authoritative. The browser does not fabricate next-run previews. Native anchor/stagger metadata is shown where supplied.

Names are trimmed/nonempty and at most 128 characters; prompts are nonempty and at most 16 KiB UTF-8, preserving intentional newlines. Review the exact agent, name, prompt and timing, then **Create disabled schedule**. The server supplies ownership and declaration identity. New jobs are isolated agent turns, disabled, retained after execution, with `wakeMode: now`, no scheduler announcements and no failure alerts. Arbitrary native extras are rejected.

Inspect the native definition, refresh if needed, then separately choose **Enable** and confirm. No announcements does **not** sandbox the agent: ordinary tools may still act externally. A native acknowledgement is not evidence of task execution/completion. Next/last-run facts appear only if native-supplied; disabled jobs need not have a next-run timestamp.

Edit changes only supported name/prompt/timing fields, preserving enabled state. Editing an enabled schedule affects future runs. **Pause** prevents future scheduling, not an already running task. No Delete, Run Now, one-shot dates, scripts/system events, arbitrary delivery or generic RPC are offered.

Edits, Enable and Pause require the exact reviewed native revision (`expectedConfigRevision`). Changed definitions require fresh review; typed fields are retained, never silently rebased or retried. Confirmations expire within 60 seconds and invalidate on target, draft, history, access/source or management-connection changes.

## Read-only and partial states

Only explicit matching native ownership is shown. Foreign, inferred/default, contradictory or session/account-owned jobs are omitted. Owned unsupported jobs may appear as minimal read-only rows without raw execution payloads. Reserved system declarations and unknown execution overrides stay read-only; the office never sanitizes/replaces them to gain editability. Unsupported revision/method contracts degrade safely, not to local emulated concurrency.

Recorded-run mode shows **current** schedules read-only. Return to live before mutation; stale sources require fresh reads. Lock clears private rows/prompts/drafts/confirmations. Keys and drafts stay in tab memory, not storage or URLs. Leaving/hiding the tab stops automatic reads and fences late replies, but cannot undo admitted mutations.

Native reads use at most 50 positions/request, 200 automatically, and 2,000 per explicit browse/reconciliation attempt. Filtered positions count. **Load more schedules** continues native browsing; an empty partial page does not prove an empty inventory. Expired/source-changed cursors require a fresh read.

Recovery metadata is separately paged: **Load more recovery records** reads retained journal records (50/page, up to 500). **Continue reconciliation** advances only that operation's bounded native scan. These three cursors are distinct, never interchangeable retries or automatic polling.

## Unknown outcomes: never recreate to retry

A lost, aborted, malformed or timed-out post-submit reply can follow a committed mutation. **Unknown** is not confirmed failure. Do not repeat creation, generate a replacement operation or reset storage to try again. Native declaration-key add is an upsert; replay could overwrite another operator's later edit.

Creation reserves durable private metadata before dispatch. Identical repeated submissions return the existing state, not another add; unresolved same-intent creation is blocked across restart. An explicitly different unrelated intent is not globally blocked. Prompts are not journaled, so drafts cannot be recovered after lock/restart.

Use **Reconcile** explicitly. It only reads the original native declaration and binding. **Observed** means found; **Changed** means the definition differs and needs inspection. Neither proves who committed nor any task result. Inspect the linked job and use revision-checked edits, not recreation. Missing results, partial scans and the 2,000-position cap remain unknown; inspect native schedules with the operator. There is no force-retry/reset control.

## Storage failures and maintenance

`DATA_DIR/control-schedules/` holds a separate identity/grant and creation journal. Keep directories 0700/files 0600 on storage supporting atomic replacement/durability barriers. Symlinks are refused; only one writer may hold the exclusive journal lock.

| State | Meaning and safe response |
| --- | --- |
| Reader unavailable / pairing or scope required | Inspect ordinary readiness/grant and native method compatibility. Never broaden the ordinary device to admin. |
| Management disabled / pairing required / unsupported | Inspect separate opt-in/device authority and native CAS/method support. Native browsing is independent. |
| Metadata unreadable (`operationsError: storage-unavailable`) | An empty preview is not proof of no pending records. Creation is blocked; native browsing and verified edits remain available. Repair with the operator, then explicitly refresh. |
| Creation storage unavailable (`schedule-storage-unavailable`) with readable metadata | Writer-only failure, such as lock contention, capacity or reservation failure. Retain readable records; browse/CAS edits are independent. No automatic retry. |
| Conflict / changed target / expired cursor | Refresh/review current native state and retained draft; never silently rebase, replace an operation or replay. |

The journal retains **500 records**, including resolved ones, with no automatic eviction/expiry. Unresolved records are never discarded. Full, corrupt or abandoned storage needs operator maintenance:

1. Stop **all** office processes/services/containers able to write this directory, including alternate installations. Verify their processes/open writers are stopped; closing browsers is insufficient.
2. Preserve a private backup of the entire scheduling directory and identity/binding metadata, retaining private permissions. Never publish the backup or credentials.
3. With the operator, inspect native declarations, owners/current definitions and recorded bindings. Resolve uncertain outcomes and an explicit retention/recovery procedure together. This delivery has no automatic compaction, reset or migration tool.
4. Never delete uncertain records or reset the journal to make creation retryable. A stale `journal.lock` may be removed manually **only after all writers are verified stopped**, preserving journal and backup. Restart one intended writer and verify reads before new explicit action.

These steps preserve evidence; an absent result is not proof replay is safe. Identity/endpoint changes can invalidate recovery bindings; never work around them by copying another device's identity.

For contributor qualification, use the source checkout's `CONTRIBUTING.md`: unchanged repository gates, installed tarball/Docker checks and the synthetic real-browser checklist. Source and locally packed artifacts do not prove public npm availability, live grants or actual runs.
