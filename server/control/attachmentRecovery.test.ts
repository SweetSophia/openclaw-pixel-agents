// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createAttachmentAdmission } from './attachmentAdmission';
import { createAttachmentService } from './attachmentService';
import { createControlGateway } from './gatewayClient';
import { createTaskService } from './taskService';
import { attachmentHost, attachmentInput, attachmentMessage, attachmentTarget, type AttachmentHostOptions } from './fixtures/attachments';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function admitted() {
  const deviceDirectory = await mkdtemp(join(tmpdir(), 'pixel-image-recovery-'));
  cleanups.push(() => rm(deviceDirectory, { recursive: true, force: true }));
  const options: AttachmentHostOptions = { reply: 'hold' };
  const host = await attachmentHost(options); cleanups.push(host.close);
  const config = { enabled: true, url: host.url, token: 'synthetic-attachment-bootstrap', deviceDirectory,
    sendEnabled: true, attachmentsEnabled: true, approvalsEnabled: false, allowTailnetHttp: false };
  const gateway = createControlGateway(config); cleanups.push(() => gateway.close());
  const registered = new Set(['main']); const tasks = createTaskService(gateway, () => registered);
  const service = createAttachmentService({ gateway, tasks, admission: createAttachmentAdmission(), enabled: () => true, registeredAgentIds: () => registered });
  cleanups.push(() => { service.close(); tasks.close(); });
  gateway.start(); await vi.waitFor(() => expect(service.status('main').canPrepare).toBe(true));
  const prepare = () => service.prepare('main', { target: attachmentTarget, message: attachmentMessage, image: attachmentInput }, service.acquirePreparation('main'));
  const review = await prepare(), unconfirmed = await prepare();
  const confirmation = { operationId: review.operationId, reviewToken: review.reviewToken, sharingAcknowledged: true as const };
  const pending = service.confirm('main', confirmation); await host.waitForAdmission();
  options.history = { inputReceipts: [], messages: [{ role: 'user', content: attachmentMessage,
    __openclaw: { runId: review.operationId, id: 'original-user-turn', seq: 7 } }] };
  return { host, options, config, gateway, registered, service, review, unconfirmed, confirmation, pending };
}

// Removing send-capability dependence must not remove source/target/generation fences.
it.each(['config.changed', 'read-only reconnect'] as const)('signed recovery reads the original lost-ACK run after %s', async transition => {
  const f = await admitted();
  if (transition === 'read-only reconnect') f.options.grants = ['operator.read'];
  f.host.disconnect(); expect(await f.pending).toMatchObject({ phase: 'unknown', nativeInvoked: true });
  await vi.waitFor(() => expect(f.gateway.status()).toMatchObject({ state: 'ready', canRead: true, canSend: transition !== 'read-only reconnect' }), { timeout: 3000 });
  if (transition === 'config.changed') {
    f.host.emit('config.changed'); await vi.waitFor(() => expect(f.gateway.attachmentCapabilities?.()).toBeNull());
  }
  expect(f.service.status('main').canPrepare).toBe(false);
  expect(() => f.service.acquirePreparation('main')).toThrow();
  const beforeCheck = f.host.frames.length;
  expect(await f.service.receipt('main', { operationId: f.review.operationId })).toEqual({
    operationId: f.review.operationId, target: attachmentTarget, phase: 'recorded', nativeInvoked: true,
    runId: f.review.operationId, messageId: 'original-user-turn', messageSeq: 7, imageEvidence: 'unverified',
  });
  const reads = f.host.frames.slice(beforeCheck).filter(frame => frame.method !== 'sessions.subscribe');
  expect(reads.map(frame => frame.method)).toEqual(['sessions.describe', 'chat.history', 'sessions.describe']);
  expect(reads[1].params).toEqual({ agentId: 'main', sessionKey: 'agent:main:fixture', limit: 50, maxBytes: 262144, inputRunIds: [f.review.operationId] });
  expect(await f.service.confirm('main', f.confirmation)).toMatchObject({ phase: 'recorded' });
  expect(await f.service.confirm('main', { operationId: f.unconfirmed.operationId, reviewToken: f.unconfirmed.reviewToken, sharingAcknowledged: true }))
    .toMatchObject({ phase: 'not-dispatched', nativeInvoked: false });
  expect(f.host.sendCount()).toBe(1);
  const connections = f.host.frames.filter(frame => frame.method === 'connect');
  expect(connections).toHaveLength(2);
  expect(connections[0].params.device.id).toBe(connections[1].params.device.id);
  expect(connections.every(frame => JSON.stringify(frame.params.scopes) === '["operator.read","operator.write"]')).toBe(true);
}, 10000);

it.each(['endpoint', 'roster', 'lifecycle', 'branch', 'generation-during-read', 'lifecycle-during-read'] as const)(
  'read-only signed recovery does not promote changed %s evidence', async change => {
    const f = await admitted(); f.options.grants = ['operator.read']; f.host.disconnect();
    expect(await f.pending).toMatchObject({ phase: 'unknown' });
    await vi.waitFor(() => expect(f.gateway.status()).toMatchObject({ state: 'ready', canRead: true, canSend: false }), { timeout: 3000 });
    if (change === 'endpoint') f.config.url = 'ws://127.0.0.1:1/';
    if (change === 'roster') f.registered.clear();
    if (change === 'lifecycle') f.options.session = { lifecycleRevision: 'life-other' };
    if (change === 'branch') f.options.session = { branchId: 'branch-other' };
    if (change === 'generation-during-read' || change === 'lifecycle-during-read') f.options.beforeRead = frame => {
      if (frame.method !== 'chat.history') return;
      if (change === 'generation-during-read') f.host.disconnect();
      else f.options.session = { lifecycleRevision: 'life-other' };
    };
    const beforeCheck = f.host.frames.length;
    const result = await f.service.receipt('main', { operationId: f.review.operationId }).catch(error => error);
    if (change === 'roster') expect(result).toMatchObject({ code: 'invalid-target' });
    else expect(result).toMatchObject({ phase: 'unknown', nativeInvoked: true, imageEvidence: 'unverified' });
    expect(f.host.frames.slice(beforeCheck).every(frame => ['sessions.describe', 'chat.history', 'sessions.subscribe'].includes(frame.method))).toBe(true);
    expect(f.host.sendCount()).toBe(1);
  }, 10000,
);

it('does not adopt a foreign authenticated endpoint when configuration changes during its handshake', async () => {
  const f = await admitted();
  const foreign = await attachmentHost({ grants: ['operator.read'], history: f.options.history,
    beforeConnect: () => { f.config.url = f.host.url; } });
  cleanups.push(foreign.close);
  f.config.url = foreign.url; f.host.disconnect(); expect(await f.pending).toMatchObject({ phase: 'unknown' });
  await vi.waitFor(() => expect(f.gateway.status()).toMatchObject({ state: 'ready', canRead: true, canSend: false }), { timeout: 3000 });
  expect(await f.service.receipt('main', { operationId: f.review.operationId })).toMatchObject({ phase: 'unknown', imageEvidence: 'unverified' });
  expect(foreign.frames.filter(frame => frame.method === 'chat.history')).toHaveLength(0);
  expect(foreign.sendCount()).toBe(0); expect(f.host.sendCount()).toBe(1);
}, 10000);
