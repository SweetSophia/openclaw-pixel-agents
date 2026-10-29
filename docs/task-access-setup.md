# Set up private task access

This guide is for the person running an OpenClaw Pixel Agents office. Each installation chooses its own access key. If you are visiting somebody else's office, ask its operator for the key; generating a different key will not unlock that installation.

The office access key is the value of `PIXEL_CONTROL_TOKEN`. It protects task details and conversation controls in Pixel Agents. OpenClaw Gateway authentication and the office's paired device grant are configured separately below. The collector's ingest token has a separate purpose too.

## 1. Generate your office key

From the repository directory, run:

```sh
npm run --silent control:key
```

With an npm installation, run `openclaw-pixel-agents --generate-key` instead. The installed launcher uses the same generator; no source checkout is needed.

The command prints one new 64-character hexadecimal key using 32 cryptographically secure random bytes from Node's `crypto.randomBytes`. It works wherever the project's supported Node.js version runs, including Windows, macOS and Linux. It does not read an existing key, write a configuration file, or rotate a running server's credentials.

Save the output in your private server configuration as `PIXEL_CONTROL_TOKEN`. Keep the same value to paste into **Unlock task details**. Share it only with people authorized to read private conversations and, when enabled, send, steer, stop work or decide approvals. The current office uses one shared operator key rather than individual user accounts.

Keep keys out of commits, browser URLs and `VITE_*` variables. This repository does not use a universal key or a developer-specific key file location.

## 2. Configure the office server

You can use your service manager's environment or the supplied [.env.example](../.env.example). For a local installation, copy that file to `.env`, generate the key above, and fill in its empty `PIXEL_CONTROL_TOKEN` value. Restrict the file to the account running the server; on POSIX hosts, `chmod 600 .env` does that. `.env` is ignored by Git.

The example starts with:

```dotenv
NODE_ENV=production
PORT=3001
DATA_DIR=./data
CORS_ORIGIN=http://localhost:3001
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
PIXEL_CONTROL_TOKEN=
CONTROL_SEND_ENABLED=false
CONTROL_APPROVALS_ENABLED=false
CONTROL_ALLOW_TAILNET_HTTP=false
```

Set `OPENCLAW_GATEWAY_URL` to your own Gateway. The loopback example assumes both processes run on the same host; a remote Gateway requires an encrypted `wss://` endpoint. Use a stable, private `DATA_DIR` so device credentials survive application builds and restarts. With the example above, run the server from the repository directory so `./data` keeps the same location.

The server does **not** automatically load `.env`. Existing process environment variables take precedence over values in an env file, so update or unset an older exported key when changing it. After installing dependencies and building, explicitly load the file with Node:

```sh
npm ci
npm run build
node --env-file=.env dist/server/server/index.js
```

For a global npm installation, create a private env file with the values above and start with `openclaw-pixel-agents --env-file /absolute/path/to/.env`. The bundled server is already built. Set a stable absolute `DATA_DIR`, or omit it to use the launcher's `~/.openclaw-pixel-agents` default. The launcher always runs in production mode.

Open `http://localhost:3001` for this local example. For a remotely accessed office, use HTTPS and replace `CORS_ORIGIN` with its exact browser origin, such as `https://office.example.com`. Follow the [reverse-proxy instructions](configuration.md#reverse-proxy-deployments) when TLS terminates at a proxy.

### Development

For the Vite client, set `NODE_ENV=development` and `CORS_ORIGIN=http://localhost:3000` in your private `.env`. Start the backend with explicit environment loading:

```sh
node --env-file=.env --import tsx server/index.ts
```

In another terminal, run `npm run dev:client` and open `http://localhost:3000`. This backend command does not watch for source changes; restart it after editing. `npm run dev` remains available when you supply the variables through the parent process environment instead.

## 3. Pair the office with OpenClaw

On first use, temporarily supply the server-only credential matching your Gateway's authentication mode: `OPENCLAW_GATEWAY_TOKEN` or `OPENCLAW_GATEWAY_PASSWORD`. Obtain it from your own Gateway's operator configuration. The office key generated in step 1 is not the credential for this step.

Start the office with those variables. It creates its own Ed25519 identity under `DATA_DIR/control/` and requests `operator.read`. If OpenClaw requires pairing, inspect the pending request in the Gateway device administration UI, or run these commands on the Gateway host:

```sh
openclaw devices list
openclaw devices approve <request-id>
```

Confirm the request belongs to this Pixel Agents office and has the intended scopes before approving it. Restart the office to retry the connection. Once it has connected successfully and saved its scoped device grant, remove the temporary Gateway bootstrap credential and restart again. It then uses its own stored grant. Do not delete or copy another client's identity to bypass pairing.

For sending, steering or stopping, set `CONTROL_SEND_ENABLED=true` and pair/approve the same office device with `operator.read` plus `operator.write`. This existing opt-in gates all three actions; it does not grant authority itself. A cached read-only grant keeps reads working while mutations remain disabled; temporarily supply the bootstrap credential again to request the upgrade, then remove it after the updated grant is stored. No administrator scope is needed or requested.

Approval review has a separate opt-in and scope; neither read nor write authority enables it. Follow [private approval handling](#private-approval-handling) before granting it.

## 4. Unlock task details

Open an agent's **Task** tab and paste the **office key from step 1** into **Unlock task details**. It is retained only in that browser tab. Lock or reload clears it.

If the office URL uses HTTP, private access is normally available only from loopback. An operator using a direct encrypted Tailscale connection can explicitly enable `CONTROL_ALLOW_TAILNET_HTTP=true`; this requires actual direct Tailnet endpoints and does not allow ordinary LAN/public HTTP. HTTPS remains the normal remote setup.

## Live follow-ups, steering and Stop

Stop and steering are merged in source through [PR #330](https://github.com/SweetSophia/openclaw-pixel-agents/pull/330) (`c86e6eb`), but are not included in published npm **1.7.0**. Exact post-merge `main` CI and CodeQL passed on that revision. Source qualification does not establish deployment or a new npm release.

The Gateway must grant `operator.write` as well as `operator.read`, and advertise the native methods. Sending and steering require `chat.send` and `sessions.create`; Stop independently requires `chat.abort`. One capability does not imply the other. Missing methods show **unsupported**; missing write authority, disabled opt-in, disconnected access and native ownership denial remain explicit unavailable states. Do not bypass them with a generic RPC endpoint, administrator grant or deprecated `sessions.steer`.

In **Conversation**, **Message delivery** defaults to follow-up. Explicit steering uses `chat.send` with `queueMode: steer` and `deliver: false`: it targets the conversation's direct work at native admission, not necessarily the run seen earlier. If that conversation becomes idle first, steering can start a new turn. Neither mode delivers externally. Command-shaped messages are rejected. On an uncertain send, the explicit retry retains the original message, intent, idempotency key and canonical conversation target, even if you edit the draft or selector. Reconnect never automatically resends it.

In the live **Task** view, Stop is available only for one identified, source-verified direct active run in the selected canonical conversation. Observations must be no older than 15 seconds and no more than 5 seconds into the future. Stale, ambiguous, unidentified, replaced or historical work cannot be stopped. Confirmation names the exact run and warns that its controlled child work may also stop; Cancel receives initial focus, Escape closes confirmation, and focus returns to Stop. If the facts become stale or ambiguous while confirmation is open, it closes without submitting. The server re-reads unchanged task facts and verifies ownership, identity, policy and authority immediately before sending `chat.abort` with that exact run ID. Native device/run ownership may still deny Stop despite a write grant.

A Stop receipt labelled **requested** confirms admission, not completion. **Not running** is not a claim that this click stopped the run. **Unknown** means the response was lost or otherwise uncertain: refresh authoritative task facts rather than assuming success or failure. There is no automatic Stop replay, including after reconnect. Duplicate attempts share the process-local attempted-operation record; it is bounded to 1,000 identities and fails closed at capacity. It is not durable across a server restart, so restarting is not a safe retry strategy.

## Private approval handling

Approval handling is implemented on the source branch and remains in review. It is not included in published npm **1.7.0**; no approvals deployment or new package publication is established. The setup below applies to a build containing the approvals implementation, not the older published artifact.

Approvals reviews pending native requests visible to the selected **live conversation audience**. It is separate from message sending and Stop. Enable it only for office-key holders authorized to make those decisions:

1. Set `CONTROL_APPROVALS_ENABLED=true` in the server environment and restart the office. Keep the same private `DATA_DIR` and device identity. With the opt-in disabled, the office does not request approval scope.
2. Explicitly pair/approve that office device for `operator.read` plus `operator.approvals` in the Gateway's device administration. If it has a cached read-only/read-write grant, temporarily supply the matching Gateway bootstrap credential from step 3 and restart to request the additional scope; inspect the actual pending device request before approving it. Remove the bootstrap credential and restart once the scoped grant is stored. Existing grants are not silently upgraded; do not copy an identity, grant administrator authority, or change reviewer policy to bypass a denial.
3. Unlock the office, choose a live conversation, and open **Approvals**. The Gateway must advertise `sessions.messages.subscribe`/`sessions.messages.unsubscribe`, `approval.get` and `approval.resolve`, and authorize `includeApprovals`. Its native record reviewer binding must also permit this device. A negotiated approval capability is not a promise that every record can be reviewed.

The supported one-time decisions are **Allow once** (`allow-once`) and **Deny** (`deny`) for safely projected exec, plugin and system-agent requests. There is no standing grant, reviewer override, global approval history, generic RPC or active external verification link. Only bounded reviewer-safe text is shown, including the full ID, kind, expiry, operation and available target/blast-radius warnings; raw policy envelopes are not forwarded.

Audience membership is not exact-run attribution. Explicit source keys distinguish selected versus child conversations. If the native source key is absent, the UI says **source conversation not reported** rather than inventing an origin. A child request can be visible to its parent's authorized audience; it is not thereby associated with a recorded run.

Choosing a decision first inspects that exact record. The named confirmation shows the canonical agent/conversation/session, full approval ID, kind, expiry, source and inspected operation. **Cancel** receives initial focus; Escape cancels only confirmation and leaves the outer detail panel open. Focus returns to a usable local approval control, or the approvals heading while controls are unavailable. The opaque inspection token binds the shown presentation and target/lifecycle, expires independently after 60 seconds, and cannot be replaced with a remembered ID. Before native dispatch the server refreshes the audience and exact record, compares the inspected presentation, and rechecks target, pending state, expiry and authority. Changed or stale facts require inspection and confirmation again; do not reuse an old confirmation.

| State | Meaning and safe next action |
| --- | --- |
| Last known / stale | The original verification time is retained and decisions are disabled. Refresh authoritative facts; stale display is not current permission. |
| Expired, cancelled or already answered | No fresh decision is submitted. Show the recorded native status. First answer wins. |
| Not applied by this request (`applied: false`) | A concurrent/native answer is displayed; it is not success attributable to this click. |
| Proven not dispatched | An expired inspection token, changed presentation or office rate limit can be rejected before native resolution. Only an explicit server `not-dispatched` disposition releases the browser attempt guard. Refresh, inspect and explicitly confirm a new decision; no old confirmation or decision is replayed. Actual approval expiry still disables decisions. |
| Outcome unknown | A dispatch may have reached the Gateway. Use **Inspect** or **Reconcile** to read native truth; pending alone does not prove failure. Never replay the decision, including after pending refresh, tab remount or reconnect. |
| Disabled, unsupported, scope required or review denied | Correct the explicit opt-in, supported Gateway contract, paired scope or native reviewer binding as appropriate. The error stays local; unrelated private panels remain unlocked. |

Discovery uses ephemeral, exact-ID observers. Their release must be acknowledged or their actual source connection invalidated; failed cleanup is retried without replaying a decision and blocks new subscriptions until ownership drains. Bounds are four concurrent operations/observers, 1,000 replay records, 100 racing events, 25 displayed records, and 200 remembered audience entries for 60 seconds. Malformed/overflowing decision-relevant data fails closed. A limited page authorizes only its displayed exact records; it is not a global list.

The server retains up to 1,000 attempted full ID/kind identities without eviction, independently of audience refresh/source changes, and admits at most ten new decision operations per minute. Saturation fails closed. The browser also retains a bounded attempted-identity guard across Approvals remounts. These are **process/tab-memory protections, not durable deduplication** across reload or server restart. Restarting is not a safe retry strategy for an uncertain decision; reconcile native state and escalate unresolved uncertainty to the Gateway operator.

Only the visible, unlocked live panel polls. Lock, close, hidden-page, credential-generation and relevant agent/conversation/lifecycle changes cancel reads and clear private display. Recorded-run selection and new-conversation drafts suppress approval reads/actions; return explicitly to the live conversation to review. Approval payloads are never added to the public roster/socket, browser storage or logs.

Identity/lifecycle or authority rejection clears the pending list, inspected record, confirmation and outcomes together, retaining only the non-payload attempted-identity guard. Transient failures may retain labelled last-known records with each record's original verification time, never action authority. An error code alone (including native `approval-unavailable` or an unclassified rate limit) cannot prove non-dispatch: lost/malformed responses, possible native attempts and pending-only reconciliation remain non-replayable.

## Recorded runs are read-only

Run history is merged in source but is not included in published npm **1.7.0**. Its selector lets you choose a source-backed recorded run, then return explicitly to **Live / latest task**. Recorded **Task**, **Conversation** and **Results** follow that run; **Usage** explains that per-run usage is unavailable and directs you back to Live for conversation totals, never invented per-run billing. **Approvals** explains that review is live-only and does not mount its reads or actions. No Stop, send, steer, approval decision, new-conversation or retry action can mutate from recorded selection. Your live draft and delivery intent remain in private tab memory and return when you choose Live. Lock or reload clears private access; no control payload is added to the public roster/socket or browser storage.

## Results and delivered files

Choose a conversation, then open **Results**. This uses the same office key and paired `operator.read` grant as Task; sending does not need to be enabled. **Result** means the task service has verified a completed result. **Latest response** explicitly leaves completion unconfirmed. A file appearing never makes a running or failed task successful.

Files come from assistant-delivered artifacts for the selected run. When a run cannot be identified, Results labels the list as conversation-wide and warns that it may include earlier work. Local workspace files, tool outputs and arbitrary host paths are not browsable here. Native `artifacts.list`, `artifacts.get` and `artifacts.download` must accept the assistant/agent/session/run filters; older Gateways that lack them show an unsupported file-discovery state while task text stays available. Native transfer was checked with OpenClaw 2026.10.3 in an isolated synthetic session, without submitting an agent task.

Text previews are plain UTF-8, limited to 256 KiB with a shortened notice. Still PNG/JPEG/WebP previews are limited to 8 MiB and 16 million pixels; animated images require download. HTML, SVG, PDF, audio, video, archives and executables are download-only. The actual transfer limit is 16 MiB even if a source declares a smaller size. Each IP has a separate content budget of two concurrent transfers and six requests per minute, with a 30-second deadline. This does not consume message-send admissions.

The visible Results tab refreshes metadata every five seconds. It retains at most 100 newest file summaries and labels shortened lists. Failed refreshes retain last-known facts with the original timestamp and disable file actions until the source is current again. **Copy displayed text** copies only the visible response; when clipboard access is unavailable, including direct-IP HTTP, select and copy the response manually.

Preview content stays in tab memory. Lock, close, hidden-page and selection/source changes cancel transfers, clear previews and revoke owned image URLs. Saved downloads remain ordinary user files. Native Gateway tickets stay on the server; external HTTP(S) references are shown with their host and require an explicit click. No workspace browser or additional permission is needed.

## Read-only workspace browsing

Available from version **1.6.0**, the **Workspace** tab browses the selected agent's configured workspace. It does not depend on a conversation or prove that a file is a task result. Workspace uses the same office key and paired `operator.read` grant as Task and Results; no additional key or write permission is needed. Treat the office key as trusted operator access to these agent files.

Open folders through the list or breadcrumbs and use Previous/Next for 50-entry pages. Refresh starts the current folder at its first page; visible metadata also updates every five seconds. A failed refresh keeps its original observation time with a last-known label and disables file actions until a current read succeeds. No conversations is a valid state for workspace browsing.

Preview and Download load bytes only after an explicit action. Native `agents.workspace.list` and `agents.workspace.get` must be advertised by the Gateway; older versions show an unsupported message while other tabs remain usable. The API exposes UTF-8 text and common images, rather than arbitrary binary downloads. The office caps text at 256 KiB and images at 1 MiB to retain the existing Gateway frame budget. Still PNG/JPEG/WebP images can be previewed; other supported native images are download-only. HTML/SVG source is shown as plain text. Unknown metadata, larger files and unsupported binary formats remain unavailable with an explanation.

Requests stay relative to the agent's workspace. The Gateway owns filesystem confinement; the office never reads host paths as a fallback. Each file action freshly checks the current parent page, size, modification time, agent and connection revision before exposing bytes. Folder changes, observed file/source changes, closing, Lock and hidden pages cancel work and clear previews. Workspace content stays out of public sockets and browser storage. Native list/get behavior was checked with installed OpenClaw handlers against isolated synthetic files; real framing, service and authenticated-route integration are also covered by controlled fixtures. No real agent task was submitted.

## Conversation usage

Available from version **1.7.0**, the read-only **Usage** tab follows the conversation selected in Task/Conversation/Results and uses the same office key and `operator.read` device grant. No provider billing credentials are needed.

The optional native `sessions.usage` method supplies recorded input, output, cache-read, cache-write and total tokens over the selected session instance's retained history. These are cumulative recorded model-call totals, not current-task totals, provider quotas, or a lifetime billing ledger. Missing counters display **Not reported**; explicit reported zero stays zero. Earlier instances after resets are not grouped into the selected instance.

Costs are USD values reported or estimated by OpenClaw, not a provider invoice. Missing pricing and incomplete/refreshing source caches remain visibly partial; a zero subtotal with missing prices is not shown as a free session. The office does not calculate its own model prices. The panel distinguishes its source-check time from the Gateway's original usage-computation time, when supplied.

The model and context-window limit come from the verified conversation row. That row does not expose an explicit occupied-context measurement in the supported Gateway contract, so **Occupied context** says **Not reported by this Gateway**. Cumulative usage is never substituted into a context percentage.

Usage refreshes every five seconds while its tab and page are visible, plus manual Refresh. It does not read task transcripts. Close, tab/selection changes, Lock and hidden pages cancel pending reads. Same-target refresh failures retain labelled last-known metrics with their original timestamps; identity or access failures clear them. Usage never enters public roster/socket payloads or browser storage. Gateways without the optional method show an unsupported state while other panels continue to work.

## Docker

The runtime image includes the key generator. From the repository root, build your image with an explicit tag, then generate a key without needing Node on the host:

```sh
docker build -t openclaw-pixel-agents .
docker run --rm openclaw-pixel-agents npm run --silent control:key
```

Pass `PIXEL_CONTROL_TOKEN`, your Gateway URL, the exact office `CORS_ORIGIN` and optional control settings through the container's environment or a private `--env-file`. Persist `/app/data` as a volume, including its `control/` device files. Inside a container, `127.0.0.1` refers to that container; use a reachable Gateway endpoint satisfying the same TLS/loopback policy rather than copying the host-only URL blindly. Keep the existing ingest/collector configuration for the office roster.

Docker's `--env-file` supplies process variables; it does not depend on the server reading a `.env` file. Use `DATA_DIR=/app/data` in the container even if your host example uses `./data`.

## Rotate or troubleshoot

- **Rotate the office key:** generate a new value, replace `PIXEL_CONTROL_TOKEN`, restart the office, and share the new value with authorized users. Existing tabs must unlock again. Keep the device identity and grant; rotating this office key does not require deleting them.
- **Task access is not connected:** check that both `OPENCLAW_GATEWAY_URL` and `PIXEL_CONTROL_TOKEN` reached the actual server process.
- **Unlock failed:** paste the value configured on that server. Generating another value alone does not change the server's key.
- **Pairing/scope error:** inspect the Gateway's pending device request and bootstrap authentication, and verify that the granted scopes match read-only or sending access.
- **Approvals unavailable while Task works:** check `CONTROL_APPROVALS_ENABLED=true`, separately paired `operator.approvals`, advertised native approval methods and record reviewer binding. Do not rotate the office key or lock unrelated panels to fix an approval-local denial.
- **Secure connection required:** use HTTPS, loopback development, or the explicitly configured direct-Tailnet exception.
- **Forbidden origin:** set the exact browser origin in `CORS_ORIGIN` and preserve the browser's `Origin` header through any reverse proxy.
- **Connected roster but unavailable tasks:** the collector feed and private Gateway connection are independent. Check the task connection and device grant separately.
- **Gateway starting or restarting (1.7.0 and newer):** private panels can be temporarily unavailable while the Gateway starts. An explicitly retryable `UNAVAILABLE` handshake response reconnects automatically with the existing device grant and bounded backoff; no pairing reset or new office key is needed. Genuine credential, scope and pairing failures still require operator attention.
