// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskService } from './taskService';
import type { ControlGateway } from './gatewayClient';
import type { ControlSendRequest } from '../../shared/control';
import { parseSendRequest } from './validation';
import { createSendService } from './sendService';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1', lifecycleRevision: 'life-1', activeLeafEntryId: 'leaf-1' };
const input: ControlSendRequest = { agentId: 'cylena', target, newConversation: false, message: '/literal hello', idempotencyKey: 'send-nonsecure123' };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(close => close()); vi.useRealTimers(); });
function fixture() {
  let canSend = true; let policy = false; let replaced = false; let persisted = false; let loseCreate = false; let loseSend = false;
  const sessions = new Map([[target.sessionKey, { ...target, key: target.sessionKey }]]);
  const admitted = new Set<string>();
  const request = vi.fn<ControlGateway['request']>(async (method, p) => {
    if (method === 'sessions.describe') return { session: !sessions.has(String(p.key)) ? null : { ...sessions.get(String(p.key)), ...(policy ? { sendDisabledReason: 'viewer' } : {}), ...(replaced ? { sessionId: 's2' } : {}) } };
    if (method === 'sessions.create') {
      if (!sessions.has(String(p.key))) sessions.set(String(p.key), { ...target, key: String(p.key), sessionKey: String(p.key), activeLeafEntryId: undefined! });
      if (loseCreate) { loseCreate = false; throw Error('lost create ack'); }
      return { key: p.key, sessionId: 's1', entry: { lifecycleRevision: 'life-1' } };
    }
    if (method === 'chat.history') return { sessionKey: p.sessionKey, sessionId: 's1', sessionInfo: { activeLeafEntryId: p.sessionKey === target.sessionKey ? 'leaf-1' : null }, messages: persisted && admitted.has(input.idempotencyKey) ? [{ role: 'user', content: 'hello', __openclaw: { id: 'u1', seq: 1, runId: input.idempotencyKey } }] : [] };
    if (method === 'chat.send') { admitted.add(String(p.idempotencyKey)); if (loseSend) { loseSend = false; throw Error('lost send ack'); } return { runId: p.idempotencyKey, status: 'started' }; }
    return {};
  });
  const gateway: ControlGateway = { start() {}, close() {}, request, onEvent: () => () => {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend }) };
  const tasks = createTaskService(gateway, () => new Set(['cylena']));
  const sends = createSendService(gateway, tasks); request.mockClear(); cleanups.push(() => { sends.close(); tasks.close(); });
  return { sends, request, admitted, sessions, set: (v: { canSend?: boolean; policy?: boolean; replaced?: boolean; persisted?: boolean; loseCreate?: boolean; loseSend?: boolean }) => { canSend = v.canSend ?? canSend; policy = v.policy ?? policy; replaced = v.replaced ?? replaced; persisted = v.persisted ?? persisted; loseCreate = v.loseCreate ?? loseCreate; loseSend = v.loseSend ?? loseSend; } };
}
describe('explicit send admission', () => {
  it('rejects malformed text, unknown fields, wrong agent and UUID-only assumptions', () => {
    expect(parseSendRequest('cylena', input)).toEqual(input);
    for (const value of [{ ...input, message: '' }, { ...input, message: ' '.repeat(3) }, { ...input, message: 'x'.repeat(8001) }, { ...input, method: 'chat.inject' }, { ...input, target: { ...target, url: 'http://other' } }, { ...input, agentId: 'other' }, { ...input, newConversation: true }]) expect(parseSendRequest('cylena', value)).toBeNull();
  });
  it('pins follow-ups with branch guards and suppresses commands and channel delivery', async () => {
    const f = fixture(); expect(await f.sends.send(input)).toMatchObject({ phase: 'accepted', idempotencyKey: input.idempotencyKey });
    expect(f.request).toHaveBeenCalledWith('chat.send', { agentId: 'cylena', sessionKey: target.sessionKey, sessionId: 's1', message: input.message, idempotencyKey: input.idempotencyKey, queueMode: 'followup', deliver: false, suppressCommandInterpretation: true, expectedLeafEntryId: 'leaf-1' }, expect.any(AbortSignal));
    expect(f.admitted.size).toBe(1);
  });
  it.each(['canSend', 'policy', 'replaced'] as const)('rejects authority, policy or lifecycle changes before admission: %s', async flag => {
    const f = fixture(); f.set({ [flag]: flag === 'canSend' ? false : true });
    await expect(f.sends.send(input)).rejects.toMatchObject({ code: flag === 'canSend' ? 'scope-required' : flag === 'policy' ? 'unsupported' : 'session-changed' });
    expect(f.admitted.size).toBe(0);
  });
  it('does not claim an empty existing transcript can atomically fence an in-place reset', async () => {
    const f = fixture(); await expect(f.sends.send({ ...input, target: { ...target, activeLeafEntryId: undefined } })).rejects.toMatchObject({ code: 'unsupported' }); expect(f.admitted.size).toBe(0);
  });
  it('coalesces duplicate clicks and reconciles persistence by exact input identity', async () => {
    const f = fixture(); const [a,b] = await Promise.all([f.sends.send(input), f.sends.send(input)]); expect(a).toEqual(b);
    expect(f.request.mock.calls.filter(([m]) => m === 'chat.send')).toHaveLength(1);
    f.set({ persisted: true }); expect(await f.sends.send(input)).toMatchObject({ phase: 'persisted', messageId: 'u1', messageSeq: 1 });
    await expect(f.sends.send({ ...input, message: 'different' })).rejects.toMatchObject({ code: 'invalid-request' });
  });
  it('keeps timeout unknown, never automatically replays, and rejects a replaced retry', async () => {
    const f = fixture(); f.set({ loseSend: true }); expect(await f.sends.send(input)).toMatchObject({ phase: 'unknown' });
    expect(f.request.mock.calls.filter(([m]) => m === 'chat.send')).toHaveLength(1);
    f.set({ replaced: true }); await expect(f.sends.send(input)).rejects.toMatchObject({ code: 'session-changed' }); expect(f.admitted.size).toBe(1);
  });
  it('derives one new key and recovers lost create/send acknowledgments with the original ID', async () => {
    const f = fixture(); const fresh = { ...input, target: undefined, newConversation: true };
    f.set({ loseCreate: true }); await expect(f.sends.send(fresh)).rejects.toMatchObject({ code: 'outcome-unknown' });
    f.set({ loseSend: true }); expect(await f.sends.send(fresh)).toMatchObject({ phase: 'unknown' });
    f.set({ persisted: true }); expect(await f.sends.send(fresh)).toMatchObject({ phase: 'persisted' });
    expect(f.sessions.size).toBe(2); expect(f.admitted.size).toBe(1);
    const creates = f.request.mock.calls.filter(([m]) => m === 'sessions.create'); expect(creates).toHaveLength(2);
    expect(creates[0][1]).toEqual(creates[1][1]); expect(creates[0][1]).toMatchObject({ key: expect.stringMatching(/^agent:cylena:pixel-[a-f0-9]{64}$/), idempotencyKey: input.idempotencyKey });
    expect(creates[0][1]).not.toHaveProperty('message');
  });
  it('limits unique operator submissions to ten per minute while allowing receipt retries', async () => {
    const f = fixture(); for(let n=0;n<10;n++) await f.sends.send({ ...input, idempotencyKey: `send-${n}` });
    await expect(f.sends.send({ ...input, idempotencyKey: 'send-eleven' })).rejects.toMatchObject({ code: 'rate-limited' });
    await expect(f.sends.send({ ...input, idempotencyKey: 'send-0' })).resolves.toMatchObject({ phase: 'accepted' });
  });
});
