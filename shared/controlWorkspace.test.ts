import { describe, expect, it } from 'vitest';
import { isWorkspacePath, parseWorkspaceFileRequest, parseWorkspaceListRequest, parseWorkspacePage, workspaceFileLimit } from './controlWorkspace';

const entry = { path: 'notes/日本語.txt', name: '日本語.txt', kind: 'file', size: 0, updatedAtMs: 100 };
const page = { agentId: 'cylena', path: 'notes', offset: 0, totalEntries: 1, entries: [entry], source: { state: 'current', observedAt: 100 }, sourceRevision: 'revision-1' };
describe('workspace boundary contracts', () => {
  it('accepts root, Unicode names and zero-byte files', () => {
    expect(parseWorkspaceListRequest({})).toEqual({ path: '', offset: 0 });
    expect(isWorkspacePath('notes/日本語.txt')).toBe(true);
    expect(parseWorkspacePage(page)).toEqual(page);
  });
  it.each(['/etc/passwd', '../secret', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:secret', '//host/share', 'a\u0000b', 'a\u0085b', 'a/'])('rejects noncanonical path %s', path => {
    expect(isWorkspacePath(path)).toBe(false); expect(parseWorkspaceListRequest({ path })).toBeNull();
  });
  it('rejects extra fields, invalid page windows and unrelated children', () => {
    expect(parseWorkspaceListRequest({ path: '', url: 'https://example.com' })).toBeNull();
    expect(parseWorkspaceListRequest({ offset: 10001 })).toBeNull();
    expect(parseWorkspacePage({ ...page, entries: [{ ...entry, path: 'other/日本語.txt' }] })).toBeNull();
    expect(parseWorkspacePage({ ...page, entries: [entry, entry], totalEntries: 2 })).toBeNull();
    expect(parseWorkspacePage({ ...page, root: '/private/host' })).toBeNull();
    expect(parseWorkspaceListRequest({ path: null })).toBeNull();
    expect(parseWorkspaceListRequest({ offset: null })).toBeNull();
    expect(parseWorkspacePage({ ...page, path: undefined })).toBeNull();
    expect(parseWorkspacePage({ ...page, offset: undefined })).toBeNull();
  });
  it('requires an exact file observation and closed intent', () => {
    const input = { path: entry.path, offset: 0, sourceRevision: 'revision-1', expected: { size: 0, updatedAtMs: 100 }, intent: 'download' };
    expect(parseWorkspaceFileRequest(input)).toEqual(input);
    expect(parseWorkspaceFileRequest({ ...input, path: '' })).toBeNull();
    expect(parseWorkspaceFileRequest({ ...input, expected: { size: 0 } })).toBeNull();
    expect(parseWorkspaceFileRequest({ ...input, intent: 'write' })).toBeNull();
  });
  it('rejects coerced source states and agent IDs rejected by task controls', () => {
    expect(parseWorkspacePage({ ...page, source: { state: ['current'], observedAt: 100 } })).toBeNull();
    expect(parseWorkspacePage({ ...page, agentId: '_agent' })).toBeNull();
  });
  it('lists children past the request path budget without admitting overlong requests', () => {
    const parent = Array(8).fill('a'.repeat(254)).join('/');
    const path = `${parent}/child.txt`;
    expect(parent.length).toBeLessThanOrEqual(2048); expect(path.length).toBeGreaterThan(2048);
    expect(parseWorkspacePage({ ...page, path: parent, entries: [{ ...entry, path, name: 'child.txt' }] })).not.toBeNull();
    expect(parseWorkspaceFileRequest({ path, offset: 0, sourceRevision: 'revision-1', expected: { size: 0, updatedAtMs: 100 }, intent: 'download' })).toBeNull();
  });
  it('bounds native text and images without trusting unknown sizes', () => {
    expect(workspaceFileLimit('notes.txt')).toBe(262144);
    expect(workspaceFileLimit('photo.PNG')).toBe(1048576);
    expect(workspaceFileLimit('animation.gif')).toBe(1048576);
  });
});
