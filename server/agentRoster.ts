import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { AGENT_ROSTER_LIMITS, createDefaultAgentRoster, parseAgentRoster, type AgentRosterDocument } from '../shared/agentRoster.cjs';
import { getRecipe } from '../shared/characterRecipes';
import type { AgentTag, CharacterRecipe } from '../shared/types';
import type { PersistedPrefs } from './validation';

export interface KnownAgent {
  id: string;
  name: string;
  pixelEnabled: boolean;
  tags: AgentTag[];
  recipe: CharacterRecipe;
  characterSpriteId?: string;
}

const DEFAULT_TAGS = new Map<string, AgentTag[]>([
  ['main', ['orchestration', 'research']], ['miku', ['creative', 'media']],
  ['chi', ['research', 'analysis']], ['sysauxilia', ['infrastructure', 'monitoring']],
  ['descartes', ['research', 'analysis']], ['cyberlogis', ['coding', 'logic']],
  ['cylena', ['coding', 'frontend']], ['cybera', ['coding', 'infrastructure']],
]);

export function createAgentRegistry(roster: AgentRosterDocument, persisted: ReadonlyMap<string, PersistedPrefs>): Map<string, KnownAgent> {
  return new Map(roster.agents.map(({ id, name }) => {
    const prefs = persisted.get(id);
    return [id, {
      id, name,
      pixelEnabled: prefs?.pixelEnabled ?? true,
      tags: [...(prefs?.tags ?? DEFAULT_TAGS.get(id) ?? [])],
      recipe: getRecipe(id, prefs?.recipe),
      ...(prefs?.characterSpriteId !== undefined ? { characterSpriteId: prefs.characterSpriteId } : {}),
    }];
  }));
}

class RosterFileError extends Error {}

/** Explicit configuration is authoritative: failures never select another roster. */
export function loadAgentRoster(rosterPath: string | undefined): AgentRosterDocument {
  if (rosterPath === undefined || rosterPath === '') return createDefaultAgentRoster();
  if (!isAbsolute(rosterPath) || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(rosterPath)) {
    throw Error('AGENT_ROSTER_PATH must be an absolute path without control characters; ~ is not expanded.');
  }
  let descriptor: number | undefined;
  let bytes: Buffer;
  try {
    // Nonblocking open lets descriptor validation reject FIFOs rather than hang.
    descriptor = openSync(rosterPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(descriptor);
    if (!info.isFile()) throw new RosterFileError('AGENT_ROSTER_PATH must reference a readable regular file.');
    if (info.size > AGENT_ROSTER_LIMITS.maxBytes) throw new RosterFileError('AGENT_ROSTER_PATH exceeds 65536 bytes (64 KiB).');
    const buffer = Buffer.alloc(AGENT_ROSTER_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > AGENT_ROSTER_LIMITS.maxBytes) throw new RosterFileError('AGENT_ROSTER_PATH exceeds 65536 bytes (64 KiB).');
    bytes = buffer.subarray(0, length);
  } catch (error) {
    throw Error(error instanceof RosterFileError ? error.message : 'Unable to read AGENT_ROSTER_PATH; check that the file exists and is accessible.');
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); }
      catch { throw Error('Unable to close the AGENT_ROSTER_PATH file.'); }
    }
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Error('AGENT_ROSTER_PATH must contain valid UTF-8 JSON.'); }
  return parseAgentRoster(value);
}
