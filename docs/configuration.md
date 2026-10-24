# Configuration reference

Supply configuration through your process/service environment or explicitly load a private file. The server does not automatically read `.env`.

- Source build: `node --env-file=.env dist/server/server/index.js`.
- npm launcher: `openclaw-pixel-agents --env-file /absolute/path/to/.env`.
- Docker: `--env-file .env` supplies the container environment.

Existing process environment variables take precedence over an env file. Start with the [example configuration](https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/.env.example). See the [task-access guide](task-access-setup.md) for key generation, pairing and send permissions.

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
| `CONTROL_SEND_ENABLED` | `false` | Enable message sends when the office device also has `operator.write`. |
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
