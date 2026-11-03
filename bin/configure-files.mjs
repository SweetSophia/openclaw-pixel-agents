import { closeSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export function writeConfigurationBundle({ directory, files }) {
  const entries = Object.entries(files);
  if (!isAbsolute(directory) || !entries.some(([name]) => name === 'office.env')
    || entries.some(([name, value]) => !['office.env', 'collector.env'].includes(name) || typeof value !== 'string')) {
    throw Error('Invalid configuration bundle.');
  }
  let created = false;
  const written = [];
  try {
    mkdirSync(directory, { mode: 0o700 });
    created = true;
    for (const [name, contents] of entries) {
      const path = join(directory, name);
      const descriptor = openSync(path, 'wx', 0o600);
      // Track ownership before writing: a full disk may leave a partial file.
      written.push(path);
      try { writeFileSync(descriptor, contents, 'utf8'); } finally { closeSync(descriptor); }
    }
    return written;
  } catch (error) {
    if (created) {
      for (const path of written) { try { unlinkSync(path); } catch { /* Preserve the original failure. */ } }
      try { rmdirSync(directory); } catch { /* Never recursively remove unexpected contents. */ }
    }
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'IO_ERROR';
    throw Object.assign(Error(code === 'EEXIST'
      ? 'Destination already exists; choose a new configuration directory. Nothing existing was overwritten.'
      : `Could not save configuration (${code}). Check the parent directory and permissions; inspect any partial new bundle before retrying.`), { code });
  }
}
