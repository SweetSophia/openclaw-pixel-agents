#!/usr/bin/env node

/**
 * Collector script for openclaw-pixel-agents.
 *
 * Runs on the OpenClaw host, calls `openclaw sessions --all-agents --json`
 * to get live agent session data, then pushes it to the pixel-agents server's
 * ingest endpoint via token-authenticated POST.
 *
 * Intended to run via systemd timer (see collector/systemd/).
 *
 * Usage:
 *   set -a; source .env.collector; set +a
 *   node collector/push-pixel-agents.mjs
 *
 * Required env vars:
 *   PIXEL_AGENTS_URL   — e.g. http://your-server:3000
 *   PIXEL_INGEST_TOKEN — shared secret matching the server's INGEST_API_TOKEN
 *
 * Optional:
 *   ACTIVE_MINUTES     — --active threshold (default 30)
 */

import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function main() {
  const { dryRun } = parseArgs(process.argv.slice(2));

  const pixelUrl = process.env.PIXEL_AGENTS_URL;
  const ingestToken = process.env.PIXEL_INGEST_TOKEN;
  const activeMinutes = process.env.ACTIVE_MINUTES || "30";

  if (!pixelUrl) throw new Error("Missing PIXEL_AGENTS_URL env var");
  if (!ingestToken) throw new Error("Missing PIXEL_INGEST_TOKEN env var");

  // Fetch live session data from OpenClaw
  console.error("Fetching OpenClaw sessions...");
  const raw = execFileSync("openclaw", [
    "sessions",
    "--all-agents",
    "--json",
    "--active", activeMinutes,
  ], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const data = JSON.parse(raw);
  const sessions = data.sessions || [];

  console.error(`Found ${sessions.length} active sessions`);

  const payload = {
    sessions,
    generatedAt: new Date().toISOString(),
  };

  if (dryRun) {
    console.log("[dry-run] Would POST to:", `${pixelUrl}/api/ingest/agents`);
    console.log("[dry-run] Payload sessions:", sessions.length);
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const ingestEndpoint = `${pixelUrl.replace(/\/$/, "")}/api/ingest/agents`;

  const response = await fetch(ingestEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestToken}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`Ingest failed (${response.status}): ${JSON.stringify(result)}`);
  }

  console.log(`Pixel agents ingest OK: ${result.agents} agents from ${result.received} sessions`);
}

main().catch((error) => {
  console.error("Pixel agents collector failed:", error.message);
  process.exitCode = 1;
});
