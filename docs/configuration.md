# Configuration reference

Supply configuration through your process/service environment or explicitly load a private file. The server does not automatically read `.env`.

- npm launcher: `openclaw-pixel-agents --env-file /absolute/path/to/.env`.
- Source build: `node --env-file=.env dist/server/server/index.js`.
- Docker: `--env-file .env` supplies the container environment.

Existing process environment variables take precedence over an env file. Start with the [example configuration](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/.env.example). See the [task-access guide](task-access-setup.md) for key generation, pairing and send permissions.

## Minimal local configuration (npm)

Install the prebuilt app using the [recommended quickstart](../README.md#quick-start-recommended). You do not need to clone or build the repository. The following setup assumes OpenClaw runs on the same host and `openclaw` is in PATH.

1. In a folder you control, use a text editor to create **`pixel-agents.env`**:

   ```dotenv
   PORT=3001
   CORS_ORIGIN=http://localhost:3001
   DATA_SOURCE=cli
   ```

   Keep the file private and out of Git; on POSIX, run `chmod 600 pixel-agents.env` from that folder. If the executable is outside PATH, add `OPENCLAW_BIN` with its full path. For OpenClaw on another host, follow the [collector guide](../collector/README.md) instead of using `DATA_SOURCE=cli`; the collector supplies roster status, not private task access.

2. From the configuration folder, start the office:

   ```sh
   openclaw-pixel-agents --env-file ./pixel-agents.env
   ```

   From another folder, pass the full path, quoted if it contains spaces. Existing environment variables override file settings. The npm launcher sets production mode and defaults storage to **`~/.openclaw-pixel-agents`**, outside its installation; you do not need `NODE_ENV` or a relative `DATA_DIR` in this minimal file. Services and multiple offices should set a stable absolute `DATA_DIR` for each office process. Give independent offices separate directories: sharing one can overwrite their preferences or layouts. See [persistent storage](#persistent-storage).

3. Open **http://localhost:3001**. Keep the terminal running; press **Ctrl+C** to stop. To change the office's listening port, update both `PORT` and `CORS_ORIGIN`, restart the office, and open the matching URL; for example, `PORT=3002` with `CORS_ORIGIN=http://localhost:3002` uses **http://localhost:3002**. If only the external browser address changes behind a reverse proxy, update `CORS_ORIGIN` to match its exact scheme, hostname and port; the backend `PORT` can stay unchanged.

This setup enables the public office/roster, not private tasks or sending. Private access requires its [own key and explicit Gateway pairing](task-access-setup.md); it is optional. The [fixed-roster limitation](../README.md#use-your-own-roster) still applies, and production does not insert demo agents when live data is unavailable. Use a trusted network or your own access controls; CORS is not a per-user login. For explanations without changing files or starting the app, run `openclaw-pixel-agents setup`.

## Guided configuration

**Unreleased source feature:** npm 1.7.0 does not contain `configure`. A source merge does not publish a new package. The [manual quickstart](#minimal-local-configuration-npm) remains available in the published release.

In a build containing the wizard, run this in an interactive terminal, from a private folder outside your repository:

```sh
openclaw-pixel-agents configure
```

From a source checkout use `node bin/openclaw-pixel-agents.mjs configure`. No build is needed to generate configuration; build before starting the source office. `configure --help` works without a terminal. `setup` still only prints instructions.

Choose local OpenClaw or a remote collector, the listener port, exact browser origin, a **new** configuration directory whose parent already exists, and a stable absolute `DATA_DIR`. The default bundle is `.openclaw-pixel-agents-config` under your home directory, outside an ordinary source checkout. Relative output-directory answers also start under home, not the working checkout. Keep explicitly chosen destinations outside Git; relative `..` segments or absolute paths can still point into a repository.

The wizard defaults `DATA_DIR` to `data` inside the chosen bundle, giving different bundles separate layouts, preferences and device identities. To retain an existing office, deliberately enter its existing absolute `DATA_DIR` instead; generating a bundle does not migrate or delete old state. This is distinct from the raw npm launcher's `~/.openclaw-pixel-agents` fallback. Changing a bundle's directory updates its suggested data path, while an explicitly selected existing state path is retained.

Local mode uses runtime PATH on POSIX or your absolute executable path. On Windows it requires an explicit directly executable OpenClaw binary: `.cmd`/`.bat` shims and the implicit PATH command are not supported by the shell-free execution path. If only npm batch shims are available, run OpenClaw on a supported host/WSL and configure the corresponding local or collector connection; the wizard does not add native Windows batch execution. Remote mode accepts fully absolute POSIX, Windows-drive and UNC paths independently of the dashboard OS, rejecting Windows batch shims; actual host execution remains unverified. See [Node's execution rules](https://nodejs.org/download/release/v26.8.2/docs/api/child_process.html#spawning-bat-and-cmd-files-on-windows).

Remote mode asks for the dashboard URL reachable by the collector (HTTPS except loopback). This can differ from the browser origin behind a proxy. URL input is visible in the terminal: never enter credentials or secret URL-path segments. The preview shows only each endpoint's origin and hides its path; the complete address remains in the private file. The wizard does not install a proxy, certificates, OpenClaw or a service, check connectivity, or change the [fixed roster](../README.md#use-your-own-roster).

Optional private access generates a separate office key and records the Gateway endpoint. It leaves sending, approvals and the direct-Tailnet HTTP exception disabled. The wizard never requests Gateway bootstrap credentials or approves devices; complete [manual pairing](task-access-setup.md#3-pair-the-office-with-openclaw) separately for `operator.read`. Retrieve `PIXEL_CONTROL_TOKEN` privately from the saved `office.env` to unlock task details. Do not generate a different key for the browser.

Review the redacted preview and answer yes to save. The default answer is no; cancellation creates nothing. Local mode writes `office.env`; remote mode also writes `collector.env` with an ingest secret matching the office file. Generated keys are never printed. Existing destinations, including empty folders and symlinks, are refused rather than merged or replaced; the wizard asks for another directory. If a different process creates that directory after the preview, the exclusive write still refuses it and the wizard requires a new destination and confirmation without discarding the connection answers. Existing credentials are not imported or rotated. Keep your current config until you have verified the replacement.

The new directory uses POSIX mode `0700` and files use `0600`. On Windows these modes do not establish private ACLs: restrict access to your account before use. Keep the whole bundle outside Git and share neither file publicly. Use a private parent directory you control. A sudden interruption during saving may leave a partial new folder; inspect it and choose another destination on retry. Control characters and Unicode line separators are rejected before trimming. Dotenv values with unsupported quote combinations are rejected at their prompts, but the output directory itself need not follow dotenv quoting rules. If its derived data path cannot be serialized, enter a different absolute `DATA_DIR`.

Start explicitly using the command printed by the wizard. The POSIX default example below uses shell expansion of `~`; on Windows use the wizard's printed PowerShell command:

```sh
openclaw-pixel-agents --env-file ~/.openclaw-pixel-agents-config/office.env
```

For remote collection, securely transfer `collector.env` to the OpenClaw host. From the source checkout or installed package directory **on that host**, run the following with the copied file's real path:

```sh
node --env-file /absolute/path/to/collector.env collector/push-pixel-agents.mjs --dry-run
```

For a global npm install the package directory is `openclaw-pixel-agents` under the path printed by `npm root --global`. Dry-run executes OpenClaw but does not transmit a token or snapshot; see [collector setup](../collector/README.md) for scheduling. Use Node's `--env-file`, not shell `source`, for generated files. Existing environment variables override file values, so review your service/shell environment before startup. CORS does not restrict the listener or provide login authentication; retain your network access controls.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Backend port in both development and production; Vite uses 3000. |
| `NODE_ENV` | Supplied by runner | `npm start`, Docker and the npm launcher use production mode. Production requires `CORS_ORIGIN`. |
| `CORS_ORIGIN` | None | Comma-separated exact browser origins allowed for Socket.IO and state-changing REST requests in production. |
| `DATA_DIR` | See storage below | Preferences, layouts and private task device credentials. Set an absolute persistent path for a service. |
| `DATA_SOURCE` | `auto` | `auto`, `cli` or `ingest`; unknown values fall back to `auto`. |
| `OPENCLAW_BIN` | `openclaw` | CLI executable for local polling. The separate collector requires an absolute path. |
| `POLL_INTERVAL` | `3000` | CLI polling interval in milliseconds. |
| `ACTIVE_MINUTES` | `30` | Session staleness threshold. |
| `OPENCLAW_AGENTS_DIR` | `~/.openclaw/agents` | Local transcript directory. |
| `INGEST_API_TOKEN` | None | Independent shared secret required for ingest ownership. |
| `RATE_LIMIT_MAX` | `10` | Authenticated ingest pushes per minute per token digest. |
| `PRE_AUTH_RATE_LIMIT_MAX` | `5` | Ingest attempts per minute per IP before authentication. |
| `PUBLIC_GET_RATE_LIMIT_MAX` | `512` | Static/SPA GET and HEAD requests per minute per IP. `/api/*` and `/socket.io/*` are exempt; several cold browsers may share an IP. |
| `PREFS_WRITE_RATE_LIMIT_MAX` | `60` | Non-layout API mutations per minute per IP. |
| `LAYOUT_WRITE_RATE_LIMIT_MAX` | `90` | Layout mutations per minute per IP. |
| `TRUST_PROXY` | Unset | Reviewed proxy hop count or IP/CIDR list; see below. |
| `OPENCLAW_GATEWAY_URL` | None | Private task Gateway endpoint. Remote connections require encrypted WebSockets; plain connections are loopback-only. No embedded credentials, query or fragment. |
| `PIXEL_CONTROL_TOKEN` | None | Separate operator key generated for this office. Both this and the Gateway URL are required for task access. |
| `CONTROL_SEND_ENABLED` | `false` | Existing write opt-in for sending, steering, Stop and conversation model changes; also requires the office device's paired `operator.write` grant and each action's supported native methods. |
| `CONTROL_APPROVALS_ENABLED` | `false` | Only exact `true` opts into native approval review. Requires separately paired `operator.approvals`, supported native methods and record reviewer binding; read/write grants do not imply it. |
| `OPENCLAW_GATEWAY_TOKEN` / `OPENCLAW_GATEWAY_PASSWORD` | None | Temporary server-only bootstrap credential for pairing. Remove after the scoped grant is saved. |
| `CONTROL_ALLOW_TAILNET_HTTP` | `false` | Explicit direct-Tailscale HTTP exception for private access. Actual local and peer Tailnet socket addresses must qualify; forwarded headers cannot enable it. |
| `LOG_LEVEL` | `info` | Server log level. |
| `FRONTEND_DIR` | Bundled `dist/client` | Override the directory serving the built client, normally unnecessary. |

All rate-limit maximums must be positive integers; malformed settings fail startup. A 429 response includes Retry-After and rate-limit headers.

## Persistent storage

| How you start the app | Default data directory |
| --- | --- |
| Source development | `server/data/` |
| Direct compiled startup / `npm start` | `dist/server/server/data/` |
| npm command | `~/.openclaw-pixel-agents/` |
| Docker image | `/app/data` |

An explicit `DATA_DIR` overrides these defaults. Relative settings resolve from the process working directory; use an absolute path for a service and reuse it across upgrades.

Retain `agent-prefs.json`, `layouts/` and, if task access is configured, `control/`. The latter holds the office's private identity and scoped device grant; do not copy another client's identity or commit these files. Persist `/app/data` as a Docker volume.

Preference and layout writes flush a same-directory temporary file, atomically replace the target, and sync its parent directory on POSIX. A pre-replacement failure preserves the old file. If replacement succeeded but durable saving cannot be confirmed, preference changes remain visible and the client reports that saving needs to be retried.

## Data-source ownership

Only one writer owns roster snapshots at a time:

- `cli` always polls locally; configuring an ingest token does not enable pushes in this mode.
- `ingest` requires `INGEST_API_TOKEN` and never starts CLI polling.
- `auto` starts with CLI polling. With an ingest token, a permanent executable/path/permission failure or the 10 MiB CLI-output cap switches it once to ingest-only. The switch stays in effect until restart. Without a token, it stays in CLI mode.

Transient failures, nonzero exits, timeouts and malformed CLI output preserve the previous snapshot without switching ownership. A successful empty session list replaces the snapshot. Repeated failures are summarized in logs; recovery is logged once.

Authenticated ingest requests receive 409 while CLI polling owns the roster. `/api/status` reports `dataSourceConfig`, `dataSourceEffective`, `dataSourceTransitioned`, `cliPolling` and `lastIngestAt`. The compatibility `dataSource` field represents effective ownership (`cli-poll` or `ingest`); use `lastIngestAt` to see accepted-push history. CLI children do not inherit the server's ingest token.

The live activity dock marks data stale after 90 seconds and checks freshness every 15 seconds. Ingest freshness uses the server's last successful push time, independently of the browser socket. Preserve the HTTP Date header so browser clock differences do not skew the displayed age.

## Reverse-proxy deployments

Set `CORS_ORIGIN` to the browser's exact scheme, hostname and port. A MagicDNS hostname and its direct IP are separate origins; list both if you use both. Forward the browser **Origin header unchanged**. Missing or rewritten origins can leave read-only roster polling working while mutations and sockets fail.

Use HTTPS for remote private task access. When TLS terminates at a proxy, configure `TRUST_PROXY` narrowly so the server can establish the original transport and client address.

| `TRUST_PROXY` value | Meaning |
| --- | --- |
| Unset, `false`, `0` | Trust no proxy; client IP is the direct socket peer. |
| A positive integer, e.g. `1` | Trust exactly that many proxy hops. |
| `loopback`, `linklocal`, `uniquelocal` | Express's address presets. |
| Comma-separated IPs/CIDRs | Trust only the specified proxy addresses, e.g. `10.0.0.0/8,127.0.0.1`. |

The trusted proxy must overwrite client-supplied forwarding headers. Use the actual hop count or reviewed proxy addresses, and prevent clients from bypassing that chain. Without correct trust, everyone behind the proxy shares an IP rate bucket. Blanket `true`, `/0` CIDRs and malformed settings are rejected at startup.

## Private access

The shared office key unlocks private task and conversation access; it does not create per-user accounts or protect every public roster/editor route. Deploy on a trusted network or behind your own access control.

Private task payloads stay off the public office socket and out of browser storage. Pairing uses the office's own device and scoped permissions. See [task access setup](task-access-setup.md) for the full procedure, key rotation and troubleshooting.

Approval review is independent of `CONTROL_SEND_ENABLED`. When enabled, the office additionally requests `operator.approvals`; it never silently upgrades a cached grant. Missing approval scope, methods or record reviewer binding is local to Approvals and does not lock other private panels. See [private approval handling](task-access-setup.md#private-approval-handling) for explicit pairing, confirmation and uncertain-outcome guidance.

Conversation model changes use `CONTROL_SEND_ENABLED` and the existing paired `operator.read`/`operator.write` grant, not a new flag or administrator permission. Model reads and writes negotiate optional native methods independently of message sending. Unexpected administrator authority disables model writes to avoid native agent/default persistence. See [conversation model selection](task-access-setup.md#conversation-model-selection) for native race, default-reset, local settlement/expiry and uncertain-outcome limits. Original source merged through PR #334 (`7bd8809`); the late-review hardening follow-up merged through PR #335 (`6012e82`) on 2026-10-30, with exact post-merge `main` [CI](https://github.com/SweetSophia/openclaw-pixel-agents/actions/runs/41120931299) and [CodeQL](https://github.com/SweetSophia/openclaw-pixel-agents/actions/runs/41120931437) successful. Source delivery does not establish live deployment or inclusion in published npm 1.7.0.
