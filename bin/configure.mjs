import { homedir } from 'node:os';
import { lstatSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildConfiguration, defaultBrowserOrigin, dotenvValue, resolveConfigurationDirectory, safeText, validateAbsolutePath, validateCollectorUrl,
  validateGatewayUrl, validateLocalExecutable, validateOrigin, validatePort, validateRemoteExecutablePath } from './configure-values.mjs';
import { writeConfigurationBundle } from './configure-files.mjs';
import { AGENT_ROSTER_LIMITS, createDefaultAgentRoster, parseAgentId, parseAgentName } from '../shared/agentRoster.cjs';

function shellPath(value) {
  return process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export async function runConfigure({ ask, output, home }) {
  output('Create a NEW configuration bundle. Existing configuration and credentials are not read or changed.\nNo services, OpenClaw commands, network checks or device approvals will run.');
  const promptAnswer = async (label, fallback, validate = value => value) => {
    for (;;) {
      let raw;
      try { raw = await ask(`${label}${fallback ? ` [${fallback}]` : ''}: `); }
      catch { throw Error('Configuration cancelled. No configuration was saved.'); }
      try {
        const answer = safeText(raw).trim();
        return { value: validate(answer || fallback), usedFallback: answer === '' };
      }
      catch (error) { output(error.message); }
    }
  };
  const prompt = async (label, fallback, validate) => (await promptAnswer(label, fallback, validate)).value;
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
  const origin = await prompt('Exact browser origin (no trailing slash)', defaultBrowserOrigin(port), validateOrigin);
  output('The browser origin does not restrict the listener or provide login authentication. Use a firewall/reverse proxy for network exposure.');
  let directory;
  let dataDir;
  let dataDirWasDefault = true;
  const destination = async () => {
    directory = await prompt('New configuration directory (relative paths start under home; parent must already exist)', join(home, '.openclaw-pixel-agents-config'), value => {
      const path = resolveConfigurationDirectory(value, home);
      dotenvValue(join(path, 'agents.json'));
      try { if (!statSync(dirname(path)).isDirectory()) throw Error(); }
      catch { throw Error('The destination parent must already exist and be an accessible directory.'); }
      try { lstatSync(path); }
      catch (error) { if (error.code === 'ENOENT') return path; throw Error('Cannot inspect this destination; check its parent and permissions.'); }
      throw Error('Destination already exists; choose a new directory.');
    });
    const suggested = dataDirWasDefault ? join(directory, 'data') : dataDir;
    const answer = await promptAnswer('Stable absolute office DATA_DIR (reuse existing state only deliberately)', suggested, validateAbsolutePath);
    dataDir = answer.value;
    dataDirWasDefault = dataDirWasDefault && answer.usedFallback;
  };
  await destination();
  let collectorUrl;
  let openclawBin;
  if (mode === 'remote') {
    output('Collector settings belong on the OpenClaw host. Its executable path is not checked on this machine.');
    output('URL input is visible in the terminal: do not enter credentials or secret path segments. URL paths are hidden in the preview.');
    collectorUrl = await prompt('Dashboard base URL reachable by the collector', '', validateCollectorUrl);
    openclawBin = await prompt('Absolute OpenClaw executable path on that host', '', validateRemoteExecutablePath);
  } else {
    openclawBin = await prompt('Local OpenClaw executable (Windows requires a directly executable binary, not a batch shim)', process.platform === 'win32' ? '' : 'openclaw', validateLocalExecutable);
  }
  output('The roster lists existing OpenClaw IDs and public display names. IDs must match OpenClaw exactly; this does not create agents or discover them. Never put secrets in a display name.');
  let roster = createDefaultAgentRoster();
  if (!await prompt('Use the built-in agent roster? (yes/no)', 'yes', yesNo)) {
    const count = await prompt('Number of agents', '1', value => {
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > AGENT_ROSTER_LIMITS.maxAgents) throw Error('Choose between 1 and 50 agents.');
      return Number(value);
    });
    const agents = [];
    const seen = new Set();
    for (let index = 1; index <= count; index++) {
      const id = await prompt(`Agent ${index} ID`, '', value => {
        const id = parseAgentId(value);
        if (seen.has(id)) throw Error('This agent ID is already in the roster; enter a different ID.');
        return id;
      });
      const name = await prompt(`Agent ${index} display name`, id, parseAgentName);
      seen.add(id); agents.push({ id, name });
    }
    roster = { version: 1, agents };
  }
  const privateAccess = await prompt('Configure optional private Task/Gateway access? (yes/no)', 'no', yesNo);
  let gatewayUrl;
  if (privateAccess) {
    output('Gateway URL input is visible: do not enter credentials or secret path segments. The preview hides its path.');
    gatewayUrl = await prompt('Gateway URL reachable from this dashboard', mode === 'local' ? 'ws://127.0.0.1:18789' : '', validateGatewayUrl);
  }
  let paths;
  for (;;) {
    const plan = buildConfiguration({ mode, port, origin, dataDir, directory, collectorUrl, openclawBin, roster, privateAccess, gatewayUrl }, { home });
    output(`Preview (secrets redacted):\n\n${plan.preview}\n\nNothing has been saved or connected. Keep the whole bundle outside Git, in a private parent directory you control. A sudden interruption during saving can leave a partial NEW bundle; retry with another directory, never overwrite it.`);
    if (process.platform === 'win32') output('Windows: POSIX file modes do not ensure ACL privacy. Secure the configuration directory to your account before using or transferring these secret files.');
    const save = await prompt('Save these new files? [y/N]', 'no', yesNo);
    if (!save) { output('Cancelled. No configuration was saved.'); return; }
    try { paths = writeConfigurationBundle(plan); break; }
    catch (error) {
      if (!['EEXIST', 'ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      output('The destination or its parent changed while saving. Choose a different directory and review again; nothing existing was overwritten.');
      await destination();
    }
  }
  output(`Saved private configuration:\n${paths.join('\n')}\n\nExisting environment variables override env-file values at startup.\nStart explicitly (PowerShell on Windows; POSIX shell elsewhere):\nopenclaw-pixel-agents --env-file ${shellPath(join(directory, 'office.env'))}\nFrom a source checkout, use node bin/openclaw-pixel-agents.mjs with the same arguments.\nBrowser: ${origin}\nNo connection has been verified.`);
  output(`Edit ${shellPath(join(directory, 'agents.json'))} to change IDs or public names, then restart the office. No rebuild or collector reconfiguration is required. Changing an ID creates a different identity; changing only its name keeps preferences. Rerunning configure creates a NEW bundle, never edits this one.`);
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
  try { await runConfigure({ ask, output: text => console.log(text), home: homedir() }); }
  finally { terminal.close(); }
}
