import { describe, expect, it } from 'vitest';
import { isAgentDocumentText, parseAgentDocumentReadRequest, parseAgentDocumentSaveRequest,
  parseAgentDocumentManagement, parseAgentDocumentSnapshot, parseAgentDocumentSaveReceipt } from './controlAgentDocuments';

const save = { name: 'AGENTS.md', revision: 'opaque-revision', operationId: 'document-unique-operation', content: '' };
const snapshot = { agentId: 'main', name: 'AGENTS.md', revision: 'opaque-revision', content: 'é', bytes: 2, source: { state: 'current', observedAt: 123 } };
describe('closed agent document contracts', () => {
  it('accepts only the four exact root names and no extra request fields', () => {
    for (const name of ['AGENTS.md', 'SOUL.md', 'USER.md', 'MEMORY.md']) expect(parseAgentDocumentReadRequest({ name })).toEqual({ name });
    for (const name of ['agents.md', 'IDENTITY.md', 'BOOTSTRAP.md', '../AGENTS.md', '/AGENTS.md', 'dir/SOUL.md', '']) expect(parseAgentDocumentReadRequest({ name })).toBeNull();
    expect(parseAgentDocumentReadRequest({ name: 'AGENTS.md', path: '/private' })).toBeNull();
    expect(parseAgentDocumentReadRequest({ name: 'AGENTS.md', [Symbol('hidden')]: 1 })).toBeNull();
  });
  it('accepts empty and strict bounded UTF-8 without normalizing submitted bytes', () => {
    for (const content of ['', '\t\r\n', '\ufeffhello', '🙂', 'é'.repeat(16384)]) expect(isAgentDocumentText(content)).toBe(true);
    for (const content of ['a'.repeat(32769), 'é'.repeat(16385), '\0', '\u0001', '\u000b', '\u007f', '\ud800', '\udfff']) expect(isAgentDocumentText(content)).toBe(false);
    expect(parseAgentDocumentSaveRequest(save)).toEqual(save);
    expect(parseAgentDocumentSaveRequest({ ...save, content: ' \r\n' })?.content).toBe(' \r\n');
  });
  it('rejects missing, malformed or writable-path revision/operation shapes', () => {
    for (const patch of [{ revision: '' }, { revision: 'a'.repeat(129) }, { operationId: '' }, { operationId: 'a'.repeat(129) }, { operationId: '../file' }, { expectedHash: 'a'.repeat(64) }, { expectedWorkspace: '/private' }, { force: true }, { content: '\ud800' }]) expect(parseAgentDocumentSaveRequest({ ...save, ...patch })).toBeNull();
    const parsed = parseAgentDocumentSaveRequest(save)!; parsed.content = 'different'; expect(save.content).toBe('');
  });
  it('validates management authority invariants and closed response sources', () => {
    const ready = { configured: true, state: 'ready', canEdit: true, epoch: 'epoch', reason: null };
    expect(parseAgentDocumentManagement(ready)).toEqual(ready);
    for (const patch of [{ epoch: null }, { reason: 'permission' }, { configured: false }, { state: 'connecting' }, { token: 'secret' }]) expect(parseAgentDocumentManagement({ ...ready, ...patch })).toBeNull();
    expect(parseAgentDocumentManagement({ configured: false, state: 'disabled', canEdit: false, epoch: null, reason: 'disabled' })).not.toBeNull();
    expect(parseAgentDocumentManagement({ ...ready, canEdit: false })).toBeNull();
    expect(parseAgentDocumentSnapshot(snapshot)).toEqual(snapshot);
    for (const patch of [{ bytes: 1 }, { workspace: '/private' }, { revision: '' }, { source: { state: 'current', observedAt: 123, path: '/private' } }]) expect(parseAgentDocumentSnapshot({ ...snapshot, ...patch })).toBeNull();
  });
  it('allows snapshots only on acknowledged saves with exact matching identity', () => {
    const receipt = { agentId: 'main', name: 'AGENTS.md', operationId: save.operationId, state: 'saved', snapshot };
    expect(parseAgentDocumentSaveReceipt(receipt)).toEqual(receipt);
    for (const state of ['conflict', 'unknown']) {
      expect(parseAgentDocumentSaveReceipt({ ...receipt, state })).toBeNull();
      const { snapshot: _, ...withoutSnapshot } = receipt;
      expect(parseAgentDocumentSaveReceipt({ ...withoutSnapshot, state })).not.toBeNull();
    }
    expect(parseAgentDocumentSaveReceipt({ ...receipt, snapshot: { ...snapshot, agentId: 'other' } })).toBeNull();
    expect(parseAgentDocumentSaveReceipt({ ...receipt, snapshot: undefined })).toBeNull();
  });
  it('rejects JSON arrays masquerading as response enum strings', () => {
    const ready = { configured: true, state: 'ready', canEdit: true, epoch: 'epoch', reason: null };
    expect(parseAgentDocumentManagement({ ...ready, state: ['ready'] })).toBeNull();
    expect(parseAgentDocumentManagement({ configured: false, state: 'disabled', canEdit: false, epoch: null, reason: ['disabled'] })).toBeNull();
    expect(parseAgentDocumentSnapshot({ ...snapshot, source: { state: ['current'], observedAt: 123 } })).toBeNull();
    expect(parseAgentDocumentSaveReceipt({ agentId: 'main', name: 'AGENTS.md', operationId: save.operationId, state: ['unknown'] })).toBeNull();
  });
});
