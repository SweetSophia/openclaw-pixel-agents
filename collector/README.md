# Collector

Pushes live OpenClaw session data to a remote pixel-agents server running in `ingest` mode.

## Setup

1. Copy `.env.collector.example` to `.env.collector` and fill in your values:
   ```bash
   cp .env.collector.example .env.collector
   nano .env.collector
   ```

2. Test it:
   ```bash
   set -a; source .env.collector; set +a
   node collector/push-pixel-agents.mjs --dry-run
   ```

3. Install the systemd timer (adjust paths in the `.service` file first):
   ```bash
   sudo cp collector/systemd/openclaw-pixel-collector.* /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now openclaw-pixel-collector.timer
   ```

4. Verify:
   ```bash
   sudo journalctl -u openclaw-pixel-collector.service -n 5
   ```

## Requirements

- `openclaw` CLI available in PATH on the host machine
- Node.js 20+
- Network access to the pixel-agents server
