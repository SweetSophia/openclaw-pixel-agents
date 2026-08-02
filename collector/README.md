# Collector

The collector reads live OpenClaw sessions on the OpenClaw host and sends them to a pixel-agents server running in `ingest` mode. CLI collection and HTTP delivery are each limited to 10 seconds. systemd begins terminating an unexpected overrun after 25 seconds and force-stops the complete control group within 5 more seconds.

## Requirements

- A Node.js version allowed by the repository's `package.json#engines`
- A non-root OS account that can read the required OpenClaw state
- The absolute paths returned by `command -v node` and `command -v openclaw`
- HTTPS access to the pixel-agents server; plain HTTP is accepted only for `localhost`, `127.0.0.0/8`, and `::1`

## Configure the collector

1. Create a private local configuration for the dry run:

   ```bash
   install -m 0600 collector/.env.collector.example collector/.env.collector
   ${EDITOR:-nano} collector/.env.collector
   ```

2. Set these required values:

   - `PIXEL_AGENTS_URL`: HTTPS URL of the pixel-agents server. For local development only, loopback HTTP is allowed.
   - `PIXEL_INGEST_TOKEN`: shared secret matching the server's `INGEST_API_TOKEN`.
   - `OPENCLAW_BIN`: absolute, reviewed path returned by `command -v openclaw`. The collector does not resolve this executable through `PATH`.

   `ACTIVE_MINUTES` is optional and defaults to `30`.

3. Test the configuration as the same account that will run the service:

   ```bash
   set -a
   source collector/.env.collector
   set +a
   node collector/push-pixel-agents.mjs --dry-run
   ```

   Dry-run mode still executes the OpenClaw CLI and validates the destination, but does not send the token or payload.

## Install the systemd timer

The checked-in unit is a portable template with generic `/opt` and `/etc` paths. Before installing it, edit a copy and set:

- `User` to the non-root account that owns the OpenClaw state. Do not use `root`.
- `WorkingDirectory` and the script path in `ExecStart` to this repository's absolute path.
- `EnvironmentFile` to the protected configuration file created above.
- The absolute Node executable in `ExecStart` if `command -v node` is not `/usr/bin/node`.
- The first directory in `Environment=PATH` to `dirname "$(command -v node)"`. Keep only that reviewed Node directory plus the minimal system directories needed by OpenClaw. This is required when the `openclaw` launcher uses `#!/usr/bin/env node`.

Do not set `HOME` manually. systemd derives it from `User`, keeping the unit portable across home-directory layouts.

```bash
sudo install -d -m 0750 /etc/openclaw-pixel-agents
sudo install -m 0600 collector/.env.collector /etc/openclaw-pixel-agents/collector.env
cp collector/systemd/openclaw-pixel-collector.service /tmp/openclaw-pixel-collector.service
sudoedit /tmp/openclaw-pixel-collector.service
sudo install -m 0644 /tmp/openclaw-pixel-collector.service /etc/systemd/system/
sudo install -m 0644 collector/systemd/openclaw-pixel-collector.timer /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/openclaw-pixel-collector.service /etc/systemd/system/openclaw-pixel-collector.timer
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-pixel-collector.timer
```

The service includes conservative hardening that preserves the OpenClaw CLI's access to its owning account's home directory and allows only Unix, IPv4, and IPv6 sockets. Review additional restrictions with `systemd-analyze security openclaw-pixel-collector.service` on the deployment host before tightening filesystem access.

## Verify operation

```bash
systemctl status openclaw-pixel-collector.timer
sudo journalctl -u openclaw-pixel-collector.service -n 20
```

A hung CLI is killed after 10 seconds and a stalled HTTP request aborts after 10 seconds. If either mechanism fails unexpectedly, systemd begins termination after 25 seconds, gives the full service control group 5 seconds to stop, and then sends SIGKILL. The next timer activation can then proceed instead of remaining blocked indefinitely.
