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
 *   PIXEL_AGENTS_URL   — HTTPS server URL, or loopback HTTP for local testing
 *   PIXEL_INGEST_TOKEN — shared secret matching the server's INGEST_API_TOKEN
 *   OPENCLAW_BIN       — absolute path to the reviewed OpenClaw executable
 *
 * Optional:
 *   ACTIVE_MINUTES     — --active threshold (default 30)
 */

import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export const OPENCLAW_TIMEOUT_MS = 10_000;
export const INGEST_TIMEOUT_MS = 10_000;

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
  }
  return args;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  return isIP(normalized) === 4 && Number(normalized.split(".", 1)[0]) === 127;
}

export function getIngestEndpoint(pixelUrl) {
  let endpoint;
  try {
    endpoint = new URL(pixelUrl);
  } catch {
    throw new Error("PIXEL_AGENTS_URL must be a valid absolute URL");
  }

  if (endpoint.username || endpoint.password) {
    throw new Error("PIXEL_AGENTS_URL must not contain credentials");
  }

  const loopbackHttp = endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !loopbackHttp) {
    throw new Error("PIXEL_AGENTS_URL must use HTTPS; HTTP is allowed only for localhost, 127.0.0.0/8, or ::1");
  }

  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/api/ingest/agents`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

export function fetchOpenClawSessions({
  openclawBin,
  activeMinutes,
  env = process.env,
  execFile = execFileSync,
  timeoutMs = OPENCLAW_TIMEOUT_MS,
}) {
  const childEnv = { ...env };
  delete childEnv.PIXEL_INGEST_TOKEN;

  const raw = execFile(openclawBin, [
    "sessions",
    "--all-agents",
    "--json",
    "--active", activeMinutes,
  ], {
    encoding: "utf8",
    // Keep aligned with server/dataSource.ts OPENCLAW_SESSIONS_EXEC_OPTIONS.
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: childEnv,
  });

  const data = JSON.parse(raw);
  if (!Array.isArray(data?.sessions)) {
    throw new Error("OpenClaw sessions JSON must contain a sessions array");
  }
  return data.sessions;
}

export async function postSnapshot({
  endpoint,
  ingestToken,
  payload,
  fetchImpl = fetch,
  timeoutMs = INGEST_TIMEOUT_MS,
}) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ingestToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });

  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (response.ok) throw error;
    result = {};
  }
  if (!response.ok) {
    throw new Error(`Ingest failed (${response.status}): ${JSON.stringify(result)}`);
  }

  return result;
}

export async function runCollector({
  argv = process.argv.slice(2),
  env = process.env,
  execFile = execFileSync,
  fetchImpl = fetch,
  now = () => new Date(),
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const { dryRun } = parseArgs(argv);

  const pixelUrl = env.PIXEL_AGENTS_URL;
  const ingestToken = env.PIXEL_INGEST_TOKEN;
  const openclawBin = env.OPENCLAW_BIN;
  const activeMinutes = env.ACTIVE_MINUTES || "30";

  if (!pixelUrl) throw new Error("Missing PIXEL_AGENTS_URL env var");
  if (!ingestToken) throw new Error("Missing PIXEL_INGEST_TOKEN env var");
  if (!openclawBin) throw new Error("Missing OPENCLAW_BIN env var");
  if (!isAbsolute(openclawBin)) throw new Error("OPENCLAW_BIN must be an absolute path");

  const ingestEndpoint = getIngestEndpoint(pixelUrl);

  // Fetch live session data from OpenClaw
  stderr("Fetching OpenClaw sessions...");
  const sessions = fetchOpenClawSessions({
    openclawBin,
    activeMinutes,
    env,
    execFile,
  });

  stderr(`Found ${sessions.length} active sessions`);

  const payload = {
    sessions,
    generatedAt: now().toISOString(),
  };

  if (dryRun) {
    stdout("[dry-run] Would POST to:", ingestEndpoint.href);
    stdout("[dry-run] Payload sessions:", sessions.length);
    return;
  }

  const result = await postSnapshot({
    endpoint: ingestEndpoint,
    ingestToken,
    payload,
    fetchImpl,
  });

  stdout(`Pixel agents ingest OK: ${result.agents} agents from ${result.received} sessions`);
}

if (import.meta.main) {
  runCollector().catch((error) => {
    console.error("Pixel agents collector failed:", error.message);
    process.exitCode = 1;
  });
}
