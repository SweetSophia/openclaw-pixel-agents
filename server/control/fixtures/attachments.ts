import { createHash } from 'node:crypto';
import type { ControlTarget } from '../../../shared/control';
import type { AttachmentImage } from '../../../shared/controlAttachments';
import type { ControlGateway, GatewayEvent } from '../gatewayClient';
import { serializeImageFollowupFrame, type AttachmentGatewayCapabilities, type NativeImageRequestFrame } from '../gatewayAttachmentPolicy';

// Synthetic fixtures matching the qualified 2026.11.2 persisted user-turn shapes.
export const attachmentTarget: ControlTarget = { agentId: 'main', sessionKey: 'agent:main:fixture', sessionId: 's1',
  lifecycleRevision: 'life-1', branchId: 'branch-1', activeLeafEntryId: 'leaf-1' };
export const attachmentMessage = 'Describe this picture';
export const attachmentInput = { filename: 'picture.png', mimeType: 'image/png' as const,
  contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6w1sAAAAASUVORK5CYII=' };
export const attachmentImage: AttachmentImage = { filename: 'picture.png', mimeType: 'image/png', bytes: 68, width: 1, height: 1,
  sha256: createHash('sha256').update(Buffer.from(attachmentInput.contentBase64, 'base64')).digest('hex') };
export const attachmentTextDigest = createHash('sha256').update(attachmentMessage).digest('hex');
export const durableOmission = '[image attachment omitted: durable managed media claim unavailable]';
export const limitOmission = '[image attachment omitted: text-only attachment limit reached]';
export function nativeImageMessage(runId = 'operation-1', kind: 'inline' | 'offloaded' = 'inline') {
  return { role: 'user', content: attachmentMessage, timestamp: 123,
    __openclaw: { id: 'user-1', seq: 7, runId, media: [{ url: 'media://inbound/fixture.png', contentType: 'image/png',
      kind: 'image', fileName: 'picture.png', sizeBytes: 68, width: 1, height: 1,
      ...(kind === 'offloaded' ? { origin: 'file' } : {}) }], mediaImageLayout: { slots: [{ kind, factIndex: 0 }] } } };
}

export function attachmentGatewayFixture() {
  const listeners = new Set<(event: GatewayEvent) => void>();
  const state = {
    enabled: true, registered: new Set(['main']), canRead: true, canSend: true,
    caps: { epoch: 'epoch-1', sourceKey: 'source-1', maxBytes: 4_194_304, maxImageBytes: 4_194_304,
      maxPayload: 6_291_456, maxBufferedBytes: 6_291_456 } as AttachmentGatewayCapabilities | null,
    session: { ...attachmentTarget, key: attachmentTarget.sessionKey } as Record<string, unknown>,
    history: { messages: [] as unknown[], inputReceipts: [] as unknown[] },
    historyOverride: undefined as Record<string, unknown> | undefined,
    consumedMessages: [] as unknown[],
    afterRequest: undefined as ((method: string, params: Record<string, unknown>) => void | Promise<void>) | undefined,
    nativeResult: (async (id: string): Promise<unknown> => ({ runId: id })) as (id: string) => Promise<unknown>,
  };
  const requests: { method: string; params: Record<string, unknown> }[] = [], nativeSends: NativeImageRequestFrame[] = [];
  const gateway: ControlGateway = {
    start() {}, close() {}, status: () => ({ configured: true, state: 'ready', canRead: state.canRead, canSend: state.canSend }),
    attachmentCapabilities: () => state.caps && { ...state.caps },
    onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async request(method, params, signal) {
      if (signal?.aborted) throw Error('Cancelled synthetic read');
      requests.push({ method, params: structuredClone(params) });
      const result = method === 'sessions.describe' ? { session: state.session }
        : method === 'chat.history' ? { sessionKey: attachmentTarget.sessionKey, sessionId: 's1',
          sessionInfo: { ...state.session, activeLeafEntryId: state.session.activeLeafEntryId }, ...state.history,
          ...(params.messageId ? { messages: state.consumedMessages } : {}), ...state.historyOverride } : {};
      const snapshot = structuredClone(result);
      await state.afterRequest?.(method, params);
      if (signal?.aborted) throw Error('Cancelled synthetic read');
      return snapshot;
    },
    async sendImageFollowup(params, epoch) {
      if (epoch !== state.caps?.epoch) throw Error('Wrong synthetic source epoch');
      const wire = serializeImageFollowupFrame({ type: 'req', id: 'native-request-1', method: 'chat.send', params }, state.caps, 0);
      nativeSends.push(JSON.parse(wire) as NativeImageRequestFrame);
      return state.nativeResult(params.idempotencyKey);
    },
  };
  return { state, gateway, requests, nativeSends, emit: (event: GatewayEvent) => { listeners.forEach(listener => listener(event)); } };
}
