// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createDefaultAgentRoster, parseAgentId, parseAgentName, parseAgentRoster } from './agentRoster.cjs';

const document = (agents: unknown = [{ id: 'researcher', name: '研究 Assistant' }]) => ({ version: 1, agents });

describe('agent roster identities and public labels', () => {
  it.each(['a', 'A', '0', 'sub-worker', 'toString', 'valueOf', 'worker_2', 'a'.repeat(64)])('retains exact identity %s', id => {
    expect(parseAgentId(id)).toBe(id);
  });
  it.each(['', '_worker', '-worker', 'a'.repeat(65), 'worker.name', '../worker', 'worker/name', 'a:b', ' worker', 'worker ', '研究', '__proto__', 'constructor', 'prototype', null, 1])('rejects invalid identity %j', value => {
    expect(() => parseAgentId(value)).toThrow(/id/i);
  });
  it.each(['研究 Assistant', 'Assistant 🚀', '<b>Assistant</b>', 'x'.repeat(128), '🚀'.repeat(64)])('keeps a public label literal: %s', name => {
    expect(parseAgentName(name)).toBe(name);
  });
  it.each(['', ' ', ' Assistant', 'Assistant ', 'x'.repeat(129), '🚀'.repeat(65), 'A\u0000B', 'A\u001bB', 'A\u007fB', 'A\u0085B', 'A\u2028B', 'A\u2029B', '\ud800', '\udc00', null, 1])('rejects malformed/noncanonical label %j', value => {
    expect(() => parseAgentName(value)).toThrow(/name/i);
  });
});

describe('versioned agent roster documents', () => {
  it('copies only validated IDs and names without rewriting them', () => {
    const input = Object.freeze({ version: 1, agents: Object.freeze([Object.freeze({ id: 'researcher', name: '研究 Assistant' })]) });
    const parsed = parseAgentRoster(input);
    expect(parsed).toEqual({ version: 1, agents: [{ id: 'researcher', name: '研究 Assistant' }] });
    expect(parsed).not.toBe(input);
    expect(parsed.agents[0]).not.toBe(input.agents[0]);
  });
  it('accepts one through fifty entries, with exact case-sensitive identity', () => {
    expect(parseAgentRoster(document()).agents).toHaveLength(1);
    expect(parseAgentRoster(document(Array.from({ length: 50 }, (_, index) => ({ id: `agent-${index}`, name: `Agent ${index}` })))).agents).toHaveLength(50);
    expect(parseAgentRoster(document([{ id: 'worker', name: 'One' }, { id: 'Worker', name: 'Two' }])).agents.map(agent => agent.id)).toEqual(['worker', 'Worker']);
  });
  it.each([
    null, [], {}, { version: 2, agents: [] }, { version: '1', agents: [] },
    { ...document(), extra: true }, { ...document(), constructor: {} },
    document([]), document(Array.from({ length: 51 }, (_, index) => ({ id: `agent-${index}`, name: 'Agent' }))),
    document(null), document([null]), document([{ id: 'worker', name: 'Agent', tags: [] }]),
    document([{ id: 'worker', name: 'Agent', prototype: {} }]),
    document([{ id: 'worker' }]), document([{ name: 'Agent' }]),
    document([{ id: 'worker', name: 'One' }, { id: 'worker', name: 'Two' }]),
  ])('rejects unsupported shape or duplicate IDs: %j', value => {
    expect(() => parseAgentRoster(value)).toThrow(/roster/i);
  });
  it('reports the field/index, not the rejected value', () => {
    expect(() => parseAgentRoster(document([{ id: 'worker', name: 'safe' }, { id: 'secret\u001bvalue', name: 'safe' }]))).toThrow(/agents\[1\].id/);
    try { parseAgentRoster(document([{ id: 'secret\u001bvalue', name: 'safe' }])); }
    catch (error) { expect(String(error)).not.toMatch(/secret|\u001b/); }
  });
  it('includes safe actionable field requirements without propagating input exceptions', () => {
    expect(() => parseAgentRoster(document([{ id: '-bad', name: 'Agent' }]))).toThrow(/agents\[0\].id:.*1–64/);
    expect(() => parseAgentRoster(document([{ id: 'worker', name: '\ud800' }]))).toThrow(/agents\[0\].name:.*well-formed/);
    const entry = { get id() { throw Error('synthetic-private-marker'); }, name: 'Agent' };
    expect(() => parseAgentRoster(document([entry]))).toThrow(/agents\[0\].id/);
    try { parseAgentRoster(document([entry])); } catch (error) { expect(String(error)).not.toContain('synthetic-private-marker'); }
  });
  it('explains ASCII identity requirements without echoing labels', () => {
    expect(() => parseAgentId('研究')).toThrow(/ASCII/);
    try { parseAgentId('研究'); } catch (error) { expect(String(error)).not.toContain('研究'); }
  });
  it('explains the line-separator restriction without echoing labels', () => {
    expect(() => parseAgentName('A\u2028B')).toThrow(/line separators/);
    try { parseAgentName('A\u2028B'); } catch (error) { expect(String(error)).not.toContain('A\u2028B'); }
  });
  it('returns the existing default roster without shared mutable entries', () => {
    const first = createDefaultAgentRoster();
    expect(first).toEqual({ version: 1, agents: [
      { id: 'main', name: 'Shodan' }, { id: 'miku', name: 'Miku' }, { id: 'chi', name: 'Chi' },
      { id: 'sysauxilia', name: 'Sysauxilia' }, { id: 'descartes', name: 'Descartes' },
      { id: 'cyberlogis', name: 'Cyberlogis' }, { id: 'cylena', name: 'Cylena' }, { id: 'cybera', name: 'Cybera' },
    ] });
    first.agents[0].name = 'changed'; first.agents.pop();
    const second = createDefaultAgentRoster();
    expect(second.agents).toHaveLength(8);
    expect(second.agents[0]).toEqual({ id: 'main', name: 'Shodan' });
  });
});
