# Collector

The collector reads live OpenClaw sessions on the OpenClaw host and sends them to a pixel-agents server running in `ingest` mode. CLI collection and HTTP delivery are each limited to 10 seconds. systemd begins terminating an unexpected overrun after 25 seconds and force-stops the complete control group within 5 more seconds.

Use one scheduled collector service per office/token and avoid overlapping manual runs or multiple producers. The current ingest API applies snapshots in arrival order, not source-time order; delayed concurrent pushes can replace newer state. This behavior predates the configuration wizard and is tracked in [#342](https://github.com/SweetSophia/openclaw-pixel-agents/issues/342). The supplied timer targets one service, but independent manual processes need their own serialization.

## Requirements

- A Node.js version allowed by the repository's `package.json#engines`
- A non-root OS account that can read the required OpenClaw state
- The absolute paths returned by `command -v node` and `command -v openclaw`
- HTTPS access to the pixel-agents server; plain HTTP is accepted only for `localhost`, `127.0.0.0/8`, and `::1`. Ingest redirects are rejected, so configure the final server URL directly.

## Configure the collector

In builds with [custom rosters](../docs/configuration.md#custom-agent-rosters), configure IDs/names through `agents.json` and `AGENT_ROSTER_PATH` **on the dashboard host**. Do not copy that path into the collector environment. Include every ID whose sessions this collector submits; unknown IDs reject the complete snapshot. Use the office visibility toggle to hide configured agents. The collector does not create/discover roster entries, and a roster/name edit needs an office restart, not a collector change.

The [guided configuration command](../docs/configuration.md#guided-configuration) is available in **1.8.0 or newer**, or a source build containing the wizard; it is not in 1.7.0. A source merge or release-preparation PR does not publish a package, so check your installed version. The wizard can generate a matching dashboard `office.env` and remote `collector.env`. Securely copy the latter to this OpenClaw host and keep it private. From this checkout's root or the installed package directory, test it with `node --env-file /absolute/path/to/collector.env collector/push-pixel-agents.mjs --dry-run`. For a global npm install, the package is under `openclaw-pixel-agents` in `npm root --global`. Use Node's env-file loader for wizard-generated files, not shell `source`; environment variables already set still take precedence. The wizard does not install a timer or verify remote connectivity. The manual alternative follows.

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

The service includes layered hardening. The baseline (always on, host-independent) tightens the kernel and process isolation: `NoNewPrivileges`, `PrivateDevices`, `PrivateTmp`, `ProtectClock`, `ProtectControlGroups`, `ProtectHostname`, `ProtectKernelLogs`, `ProtectKernelModules`, `ProtectKernelTunables`, `ProtectProc=invisible`, `ProcSubset=pid`, `RemoveIPC`, `RestrictNamespaces`, `RestrictRealtime`, `RestrictSUIDSGID`, `LockPersonality`, empty `CapabilityBoundingSet`, and `SystemCallArchitectures=native`. Together with the existing address-family restriction this leaves the process with no ambient capabilities and a kernel attack surface narrowed to native syscalls only.

A second, host-dependent layer (`ProtectSystem=strict` + `ReadWritePaths=`, `ProtectHome=true`, `PrivateUsers=true`, `MemoryDenyWriteExecute=true`) is **intentionally left as a commented template** at the bottom of the unit. The collector spawns the OpenClaw CLI (`OPENCLAW_BIN`), which reads its own state from a path the operator chose at install time — typically `$HOME` or somewhere under `/var/lib`. Each of these directives can break a working install that relies on those paths (or, for `MemoryDenyWriteExecute`, on Node's V8 JIT), so they must be enabled one at a time with verification. See `systemd-analyze security openclaw-pixel-collector.service` on the deployment host for the per-directive score impact.

## Verify operation

```bash
systemctl status openclaw-pixel-collector.timer
sudo journalctl -u openclaw-pixel-collector.service -n 20
```

A hung CLI is killed after 10 seconds and a stalled HTTP request aborts after 10 seconds. If either mechanism fails unexpectedly, systemd begins termination after 25 seconds, gives the full service control group 5 seconds to stop, and then sends SIGKILL. The next timer activation can then proceed instead of remaining blocked indefinitely.
