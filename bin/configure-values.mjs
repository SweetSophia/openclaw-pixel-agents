import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { getIngestEndpoint } from '../collector/push-pixel-agents.mjs';

export function safeText(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw Error('Use a single line without terminal control characters.');
  }
  return value;
}

export function dotenvValue(value) {
  safeText(value);
  const quote = !value.includes("'") ? "'" : !value.includes('"') ? '"' : null;
  if (!quote) throw Error('Values containing both single and double quotes are not supported; choose another path or value.');
  const encoded = `${quote}${value}${quote}`;
  if (parseEnv(`VALUE=${encoded}\n`).VALUE !== value) throw Error('This value cannot be represented safely in an environment file; choose another path or value.');
  return encoded;
}

export function validatePort(value) {
  safeText(value);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw Error('Listener port must be an integer from 1 to 65535.');
  return String(Number(value));
}

export function validateOrigin(value) {
  safeText(value);
  let url;
  try { url = new URL(value); } catch { throw Error('Browser origin must be an exact HTTP(S) origin.'); }
  if (!['http:', 'https:'].includes(url.protocol) || value !== url.origin) {
    throw Error('Browser origin must be an exact HTTP(S) origin without a path, credentials, query or fragment (no trailing slash).');
  }
  return value;
}

export function validateAbsolutePath(value) {
  dotenvValue(value);
  if (!isAbsolute(value)) throw Error('Use an absolute path, not a relative path or ~ abbreviation.');
  return value;
}

export function validateCollectorUrl(value) {
  safeText(value);
  try {
    const url = new URL(value);
    if (url.search || url.hash || /[?#]/.test(value)) throw Error();
    getIngestEndpoint(value);
  } catch { throw Error('Collector destination must use HTTPS (HTTP only on loopback), without credentials, query or fragment.'); }
  return value;
}

export function validateGatewayUrl(value) {
  safeText(value);
  let url;
  try { url = new URL(value); } catch { throw Error('Enter a valid Gateway URL.'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) || url.username || url.password
    || /[?#]/.test(value)) throw Error('Gateway must use an encrypted remote connection or a loopback WebSocket URL, without credentials, query or fragment.');
  return url.href;
}

export function buildConfiguration(answers, { home, cwd }) {
  const mode = answers.mode ?? 'local';
  if (!['local', 'remote'].includes(mode)) throw Error('Choose local or remote mode.');
  const port = validatePort(String(answers.port ?? '3001'));
  const office = {
    PORT: port,
    CORS_ORIGIN: validateOrigin(answers.origin ?? `http://localhost:${port}`),
    DATA_DIR: validateAbsolutePath(answers.dataDir ?? join(home, '.openclaw-pixel-agents')),
    DATA_SOURCE: mode === 'remote' ? 'ingest' : 'cli',
    CONTROL_SEND_ENABLED: 'false', CONTROL_APPROVALS_ENABLED: 'false', CONTROL_ALLOW_TAILNET_HTTP: 'false',
  };
  const directoryInput = safeText(answers.directory ?? 'pixel-agents-config');
  if (!directoryInput.trim()) throw Error('Choose a new output directory.');
  const directory = validateAbsolutePath(resolve(cwd, directoryInput));
  let collector;
  if (mode === 'remote') {
    collector = {
      PIXEL_AGENTS_URL: validateCollectorUrl(answers.collectorUrl ?? ''),
      PIXEL_INGEST_TOKEN: randomBytes(32).toString('hex'),
      OPENCLAW_BIN: validateAbsolutePath(answers.openclawBin ?? ''),
    };
    office.INGEST_API_TOKEN = collector.PIXEL_INGEST_TOKEN;
  } else if (answers.openclawBin && answers.openclawBin !== 'openclaw') {
    office.OPENCLAW_BIN = validateAbsolutePath(answers.openclawBin);
  }
  const privateAccess = answers.privateAccess === true;
  if (privateAccess) {
    office.OPENCLAW_GATEWAY_URL = validateGatewayUrl(answers.gatewayUrl ?? (mode === 'local' ? 'ws://127.0.0.1:18789' : ''));
    office.PIXEL_CONTROL_TOKEN = randomBytes(32).toString('hex');
  }
  const environments = { 'office.env': office, ...(collector ? { 'collector.env': collector } : {}) };
  const serialize = env => Object.entries(env).map(([key, value]) => `${key}=${dotenvValue(value)}`).join('\n') + '\n';
  const files = Object.fromEntries(Object.entries(environments).map(([name, env]) => [name, serialize(env)]));
  const preview = Object.entries(environments).map(([name, env]) => `${join(directory, name)}\n${Object.entries(env)
    .map(([key, value]) => `${key}=${key.includes('TOKEN') ? '[redacted]' : value}`).join('\n')}`).join('\n\n');
  return { directory, files, preview, mode, privateAccess };
}
