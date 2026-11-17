import React from 'react';
import express from 'express';
import httpRequest from 'supertest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ControlAccessProvider, useControlAccess, useConversationDrafts } from './ControlAccess';
import { useAgentDocuments } from './useAgentDocuments';
import { createAgentDocumentService } from '../../server/control/agentDocumentService';
import { createControlRouter } from '../../server/control/routes';
import { createTaskService } from '../../server/control/taskService';
import { createWorkspaceService } from '../../server/control/workspaceService';
import { loadControlConfig } from '../../server/control/config';
import type { AgentDocumentGateway, ControlGateway } from '../../server/control/gatewayClient';
import type { AgentDocumentManagement } from '../../shared/controlAgentDocuments';
import { nativeDocument } from '../../server/control/fixtures/agentDocuments';

const disposals: (() => void)[] = [];
afterEach(() => { cleanup(); for (const dispose of disposals.splice(0).reverse()) dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const wrapper = ({ children }: React.PropsWithChildren) => <ControlAccessProvider>{children}</ControlAccessProvider>;

it.each(['read', 'save'] as const)('retains access and independent private drafts when document pairing is lost before %s admission', async operation => {
  let management: AgentDocumentManagement = { configured: true, state: 'ready', canEdit: true, epoch: 'fixture-document-epoch', reason: null };
  const nativeFrames: { method: string; params: Record<string, unknown> }[] = [];
  const documentGateway: AgentDocumentGateway = {
    start() {}, close() {}, onEvent: () => () => {}, status: () => management,
    connection: () => management.canEdit ? { epoch: management.epoch!, gatewayUrl: 'ws://127.0.0.1:1', deviceId: 'fixture-document-device' } : null,
    async request(method, params) { nativeFrames.push({ method, params }); return nativeDocument(); },
  };
  const documents = createAgentDocumentService(documentGateway, () => new Set(['main'])); disposals.push(() => documents.close());
  const ordinaryGateway: ControlGateway = {
    start() {}, close() {}, onEvent: () => () => {}, status: () => ({ configured: true, state: 'ready', canRead: true, canSend: true }),
    async request() { return { agentId: 'main', path: '', offset: 0, totalEntries: 0, entries: [] }; },
  };
  const tasks = createTaskService(ordinaryGateway, () => new Set(['main'])); disposals.push(() => tasks.close());
  const workspace = createWorkspaceService(ordinaryGateway, () => new Set(['main'])); disposals.push(() => workspace.close());
  const config = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'ws://127.0.0.1:1', PIXEL_CONTROL_TOKEN: 'isolated-document-access-fixture' }, '/unused-document-access-fixture');
  const app = express(); app.use(express.json({ limit: '100kb' })); app.use('/api/control', createControlRouter({ gateway: ordinaryGateway, tasks, workspace, documents, config }));
  let pairingRace = false;
  const responses: { path: string; status: number; code?: string; authorization: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const path = String(input);
    if (pairingRace && path.endsWith(`/documents/${operation}`)) {
      management = { configured: true, state: 'pairing-required', canEdit: false, epoch: null, reason: 'pairing-required' };
      pairingRace = false;
    }
    const authorization = new Headers(init.headers).get('Authorization');
    const request = init.method === 'POST' ? httpRequest(app).post(path) : httpRequest(app).get(path);
    if (authorization) request.set('Authorization', authorization);
    if (typeof init.body === 'string') request.set('Content-Type', 'application/json').send(init.body);
    const response = await request;
    responses.push({ path, status: response.status, code: response.body.code, authorization });
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }));
  const { result } = renderHook(() => ({ access: useControlAccess(), drafts: useConversationDrafts()!, documents: useAgentDocuments({ agentId: 'main', active: true, opened: true }) }), { wrapper });
  await act(() => result.current.access.unlock('isolated-document-access-fixture'));
  await waitFor(() => expect(result.current.documents.management?.canEdit).toBe(true));
  await act(() => result.current.documents.select('AGENTS.md'));
  expect(result.current.documents.draft).toBe('original');
  act(() => {
    result.current.documents.setDraft('dirty private agent document');
    result.current.drafts.set('independent-conversation', { text: 'unsent private conversation', submission: null });
  });
  expect(result.current.documents.canSave).toBe(true);
  const generation = result.current.access.generation; pairingRace = true;
  await act(() => operation === 'read' ? result.current.documents.reload() : result.current.documents.save());
  expect(result.current.access.state).toBe('unlocked');
  expect(result.current.access.generation).toBe(generation);
  expect(result.current.documents.draft).toBe('dirty private agent document'); expect(result.current.documents.dirty).toBe(true);
  expect(result.current.drafts.get('independent-conversation')).toEqual({ text: 'unsent private conversation', submission: null });
  expect(result.current.documents.error?.code).toBe('document-denied'); expect(result.current.documents.canSave).toBe(false);
  expect(responses.find(row => row.path.endsWith(`/documents/${operation}`) && row.status === 403)).toMatchObject({ code: 'document-denied' });
  await act(() => result.current.documents.refreshManagement());
  expect(result.current.documents.management).toMatchObject({ state: 'pairing-required', reason: 'pairing-required', canEdit: false });
  const admissions = responses.length; await act(() => result.current.documents.save()); expect(responses).toHaveLength(admissions);
  await act(async () => { expect(await result.current.access.request('/api/control/agents/main/workspace', { method: 'POST', body: '{}' })).toMatchObject({ agentId: 'main', entries: [] }); });
  expect(responses[responses.length - 1]).toMatchObject({ status: 200, authorization: 'Bearer isolated-document-access-fixture' });
  expect(nativeFrames).toEqual([{ method: 'agents.files.get', params: { agentId: 'main', name: 'AGENTS.md' } }]);
});
