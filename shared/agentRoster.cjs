'use strict';

const AGENT_ROSTER_LIMITS = Object.freeze({ maxAgents: 50, maxBytes: 65536, maxIdLength: 64, maxNameLength: 128 });
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_REQUIREMENTS = `use 1–${AGENT_ROSTER_LIMITS.maxIdLength} letters/digits/_/-, starting with a letter or digit, and no reserved identities`;
const NAME_REQUIREMENTS = `use 1–${AGENT_ROSTER_LIMITS.maxNameLength} well-formed Unicode code units without surrounding whitespace or control characters`;
const DEFAULT_AGENTS = [
  ['main', 'Shodan'], ['miku', 'Miku'], ['chi', 'Chi'], ['sysauxilia', 'Sysauxilia'],
  ['descartes', 'Descartes'], ['cyberlogis', 'Cyberlogis'], ['cylena', 'Cylena'], ['cybera', 'Cybera'],
];

function parseAgentId(value) {
  if (typeof value !== 'string' || value.length > AGENT_ROSTER_LIMITS.maxIdLength || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || RESERVED_IDS.has(value)) {
    throw Error(`Invalid roster id: ${ID_REQUIREMENTS}.`);
  }
  return value;
}

function parseAgentName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > AGENT_ROSTER_LIMITS.maxNameLength
    || value.trim() !== value || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw Error(`Invalid roster name: ${NAME_REQUIREMENTS}.`);
  }
  return value;
}

function hasOnlyKeys(value, keys) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).every(key => keys.includes(key));
}

function parseAgentRoster(value) {
  if (!hasOnlyKeys(value, ['version', 'agents']) || value.version !== 1 || !Array.isArray(value.agents)
    || value.agents.length < 1 || value.agents.length > AGENT_ROSTER_LIMITS.maxAgents) {
    throw Error('Invalid roster: expected version 1 and 1–50 agents, with no unknown fields.');
  }
  const seen = new Set();
  const agents = value.agents.map((entry, index) => {
    if (!hasOnlyKeys(entry, ['id', 'name'])) throw Error(`Invalid roster agents[${index}]: expected only id and name.`);
    let id;
    let name;
    try { id = parseAgentId(entry.id); } catch { throw Error(`Invalid roster agents[${index}].id: ${ID_REQUIREMENTS}.`); }
    try { name = parseAgentName(entry.name); } catch { throw Error(`Invalid roster agents[${index}].name: ${NAME_REQUIREMENTS}.`); }
    if (seen.has(id)) throw Error(`Invalid roster agents[${index}].id: duplicate identity.`);
    seen.add(id);
    return { id, name };
  });
  return { version: 1, agents };
}

function createDefaultAgentRoster() {
  return { version: 1, agents: DEFAULT_AGENTS.map(([id, name]) => ({ id, name })) };
}

// Static assignments keep native ESM named imports and compiled CommonJS aligned.
exports.AGENT_ROSTER_LIMITS = AGENT_ROSTER_LIMITS;
exports.parseAgentId = parseAgentId;
exports.parseAgentName = parseAgentName;
exports.parseAgentRoster = parseAgentRoster;
exports.createDefaultAgentRoster = createDefaultAgentRoster;
