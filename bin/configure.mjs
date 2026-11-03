import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { buildConfiguration, dotenvValue, safeText, validateAbsolutePath, validateCollectorUrl,
  validateGatewayUrl, validateOrigin, validatePort, validateRemoteExecutablePath } from './configure-values.mjs';
import { writeConfigurationBundle } from './configure-files.mjs';

function shellPath(value) {
  return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function runConfigure({ ask, output, home, cwd }) {
  output('Create a NEW configuration bundle. Existing configuration and credentials are not read or changed.\nNo services, OpenClaw commands, network checks or device approvals will run.');
  const prompt = async (label, fallback, validate = value => value) => {
    for (;;) {
      let raw;
      try { raw = await ask(`${label}${fallback ? ` [${fallback}]` : ''}: `); }
      catch { throw Error('Configuration cancelled. No configuration was saved.'); }
      try { return validate(safeText(raw).trim() || fallback); }
      catch (error) { output(error.message); }
    }
  };
  const yesNo = value => {
    if (/^(y|yes)$/i.test(value)) return true;
    if (/^(n|no)$/i.test(value)) return false;
    throw Error('Answer yes or no.');
  };
  const mode = await prompt('OpenClaw location (local/remote)', 'local', value => {
    if (!['local', 'remote'].includes(value)) throw Error('Choose local or remote.');
    return value;
  });
  const port = await prompt('Listener port', '3001', validatePort);
  const origin = await prompt('Exact browser origin (no trailing slash)', `http://localhost:${port}`, validateOrigin);
  output('The browser origin does not restrict the listener or provide login authentication. Use a firewall/reverse proxy for network exposure.');
  const dataDir = await prompt('Stable absolute office DATA_DIR (use a different path for each independent office)', join(home, '.openclaw-pixel-agents'), validateAbsolutePath);
  const directory = await prompt('New configuration directory (parent must already exist)', join(home, '.openclaw-pixel-agents-config'), value => {
    dotenvValue(value); return resolve(cwd, value);
  });
  let collectorUrl;
  let openclawBin;
  if (mode === 'remote') {
    output('Collector settings belong on the OpenClaw host. Its executable path is not checked on this machine.');
    collectorUrl = await prompt('Dashboard base URL reachable by the collector', '', validateCollectorUrl);
    openclawBin = await prompt('Absolute OpenClaw executable path on that host', '', validateRemoteExecutablePath);
  } else {
    openclawBin = await prompt('Local OpenClaw executable (openclaw uses runtime PATH)', 'openclaw', value => value === 'openclaw' ? value : validateAbsolutePath(value));
  }
  const privateAccess = await prompt('Configure optional private Task/Gateway access? (yes/no)', 'no', yesNo);
  let gatewayUrl;
  if (privateAccess) {
    gatewayUrl = await prompt('Gateway URL reachable from this dashboard', mode === 'local' ? 'ws://127.0.0.1:18789' : '', validateGatewayUrl);
  }
  const plan = buildConfiguration({ mode, port, origin, dataDir, directory, collectorUrl, openclawBin, privateAccess, gatewayUrl }, { home, cwd });
  output(`Preview (secrets redacted):\n\n${plan.preview}\n\nNothing has been saved or connected. Keep the whole bundle outside Git, in a private parent directory you control. A sudden interruption during saving can leave a partial NEW bundle; retry with another directory, never overwrite it.`);
  if (process.platform === 'win32') output('Windows: POSIX file modes do not ensure ACL privacy. Secure the configuration directory to your account before using or transferring these secret files.');
  const save = await prompt('Save these new files? [y/N]', 'no', yesNo);
  if (!save) { output('Cancelled. No configuration was saved.'); return; }
  const paths = writeConfigurationBundle(plan);
  output(`Saved private configuration:\n${paths.join('\n')}\n\nExisting environment variables override env-file values at startup.\nStart explicitly (PowerShell on Windows; POSIX shell elsewhere):\nopenclaw-pixel-agents --env-file ${shellPath(join(directory, 'office.env'))}\nFrom a source checkout, use node bin/openclaw-pixel-agents.mjs with the same arguments.\nBrowser: ${origin}\nNo connection has been verified.`);
  if (mode === 'remote') output('Securely copy collector.env to the OpenClaw host; it contains the shared ingest secret.\nFrom the source checkout or installed package directory on that host, replace the path below with the copied file:\nnode --env-file /absolute/path/to/collector.env collector/push-pixel-agents.mjs --dry-run\nDry-run executes OpenClaw on that host but does not send a snapshot. See collector/README.md for scheduling.\nPublic roster ingestion alone does not enable private tasks.');
  if (privateAccess) output(`Private access still requires explicit Gateway pairing with operator.read.\nRetrieve PIXEL_CONTROL_TOKEN privately from ${join(directory, 'office.env')} and enter it in Unlock task details; do not share the file.\nGateway bootstrap credentials remain a separate manual server-only step. Never paste them in the browser.\nSend, approvals and Tailnet HTTP exceptions remain disabled.\nPairing guide: https://github.com/SweetSophia/openclaw-pixel-agents/blob/main/docs/task-access-setup.md`);
}

export async function configure() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('configure requires an interactive terminal. Use setup for read-only manual instructions.');
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let rejectPending;
  terminal.on('SIGINT', () => terminal.close());
  terminal.on('close', () => { rejectPending?.(Error('Input closed')); });
  const ask = question => new Promise((accept, reject) => {
    if (terminal.closed) { reject(Error('Input closed')); return; }
    rejectPending = reject;
    terminal.question(question, answer => { rejectPending = undefined; accept(answer); });
  });
  try { await runConfigure({ ask, output: text => console.log(text), home: homedir(), cwd: process.cwd() }); }
  finally { terminal.close(); }
}
