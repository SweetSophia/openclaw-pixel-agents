import React from 'react';
import { Blob as NodeBlob } from 'node:buffer';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskResults } from './TaskResults';
import type { TaskDetailsState } from '../control/useTaskDetails';
import type { ControlResultsSnapshot } from '../../shared/controlResults';
import { ControlApiError } from '../control/api';

const f = vi.hoisted(() => ({ requestFile: vi.fn(), state: 'unlocked', generation: 1, status: { canRead: true, state: 'ready' } }));
vi.mock('../control/ControlAccess', () => ({ useControlAccess: () => f }));
const target = { agentId: 'cylena', sessionKey: 'agent:cylena:test', sessionId: 's1' };
const snapshot = (changes: Partial<ControlResultsSnapshot> = {}): ControlResultsSnapshot => ({ target, scope: { kind: 'run', runId: 'r1' }, source: { state: 'current', observedAt: 123 }, sourceRevision: 'source-1',
  runState: 'completed', responseKind: 'result', response: { id: 'm1', role: 'assistant', text: 'Review complete.\n<script>literal</script>', truncated: false }, artifactState: 'ready',
  artifacts: [{ id: 'file-1', type: 'file', title: 'report.txt', mimeType: 'text/plain', download: 'bytes' }], artifactsTruncated: false, ...changes });
const state = (results: ControlResultsSnapshot | null): TaskDetailsState => ({ results, selected: { ...target, name: 'Test', hasActiveRun: false, isChild: false }, sessions: [], task: null, loading: false, sessionsLoading: false, error: null,
  refresh: vi.fn(), loadEarlier: vi.fn(), loadMoreSessions: vi.fn(), selectSession: vi.fn(), selectCreatedSession: vi.fn() });
beforeEach(() => { f.state = 'unlocked'; f.status.canRead = true; vi.stubGlobal('Blob', NodeBlob); f.requestFile.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('Results and delivered Files', () => {
  it.each(['application/typescript', 'application/x-javascript', 'application/ld+json'])('offers the supported %s code/text preview', mimeType => {
    render(<TaskResults state={state(snapshot({ artifacts: [{ id: 'code', title: 'source-file', type: 'file', mimeType, download: 'bytes' }] }))} active />);
    expect(screen.getByRole('button', { name: 'Preview source-file' })).toBeVisible();
  });
  it('announces a new followed task scope politely without moving focus', () => {
    const { rerender } = render(<TaskResults state={state(snapshot())} active />); const copy = screen.getByRole('button', { name: 'Copy displayed text' }); copy.focus();
    const announcement = screen.getByRole('status', { name: 'Results updates' }); expect(announcement).toHaveAttribute('aria-live', 'polite'); expect(announcement).toHaveTextContent('r1');
    rerender(<TaskResults state={state(snapshot({ scope: { kind: 'run', runId: 'r2' } }))} active />); expect(announcement).toHaveTextContent('r2'); expect(copy).toHaveFocus();
  });
  it('labels only verified results and renders response text literally', () => {
    render(<TaskResults state={state(snapshot())} active />);
    expect(screen.getByRole('heading', { name: /^Result$/ })).toBeVisible(); expect(screen.getByText(/<script>literal/)).toBeVisible(); expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/Size unknown/)).toBeVisible(); expect(screen.getByText(/files delivered.*assistant/i)).toBeVisible();
  });
  it.each(['running', 'failed', 'unknown'] as const)('keeps %s work unconfirmed despite delivered files', runState => {
    render(<TaskResults state={state(snapshot({ runState, responseKind: 'latest' }))} active />);
    expect(screen.getByRole('heading', { name: 'Latest response' })).toBeVisible(); expect(screen.getByText(/completion is not confirmed/i)).toBeVisible();
    expect(screen.queryByRole('heading', { name: /^Result$/ })).toBeNull();
  });
  it('authored empty, unsupported, unavailable, shortened and conversation-scope states remain explicit', () => {
    const { rerender } = render(<TaskResults state={state(snapshot({ responseKind: 'none', response: undefined, artifacts: [], scope: { kind: 'conversation' } }))} active />);
    expect(screen.getByText(/no visible assistant response/i)).toBeVisible(); expect(screen.getByText(/no assistant-delivered files/i)).toBeVisible(); expect(screen.getByText(/earlier work/i)).toBeVisible();
    rerender(<TaskResults state={state(snapshot({ artifactState: 'unsupported', artifacts: [] }))} active />); expect(screen.getByText(/does not support.*file discovery/i)).toBeVisible();
    rerender(<TaskResults state={state(snapshot({ artifactState: 'unavailable', artifacts: [] }))} active />); expect(screen.getByText(/file list is temporarily unavailable/i)).toBeVisible();
    rerender(<TaskResults state={state(snapshot({ artifactsTruncated: true }))} active />); expect(screen.getByText(/newest.*files.*shortened/i)).toBeVisible();
  });
  it('keeps original stale timestamp, disables content and clears previews without changing focus', async () => {
    f.requestFile.mockResolvedValue({ kind: 'bytes', blob: new NodeBlob(['Preview text'], { type: 'text/plain' }), filename: 'report.txt', truncated: true });
    const { rerender } = render(<TaskResults state={state(snapshot())} active />); const preview = screen.getByRole('button', { name: 'Preview report.txt' }); preview.focus(); fireEvent.click(preview);
    await screen.findByText('Preview text'); expect(screen.getByText(/preview.*shortened/i)).toBeVisible();
    rerender(<TaskResults state={state(snapshot({ source: { state: 'stale', observedAt: 123 } }))} active />);
    expect(screen.getByText(/last known/i)).toHaveTextContent(new Date(123).toLocaleString()); expect(screen.queryByText('Preview text')).toBeNull(); expect(preview).toHaveAttribute('aria-disabled', 'true'); expect(document.activeElement).toBe(preview);
  });
  it.each([false, true])('provides manual copy guidance when clipboard is absent or rejects (%s)', async rejects => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: rejects ? { writeText: vi.fn().mockRejectedValue(Error()) } : undefined });
    render(<TaskResults state={state(snapshot({ response: { id: 'm1', role: 'assistant', text: 'line one\nline two', truncated: true } }))} active />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy displayed text' })); await screen.findByText(/copy.*manually/i);
    expect(screen.getByText('line one line two')).toHaveTextContent('line one line two'); expect(screen.getByText(/only the displayed text/i)).toBeVisible();
  });
  it('surfaces file-gone errors and explicit external-host actions without automatic navigation', async () => {
    f.requestFile.mockRejectedValueOnce(new ControlApiError('file-unavailable')).mockResolvedValueOnce({ kind: 'external', title: 'Report', host: 'example.com', url: 'https://example.com/report' });
    render(<TaskResults state={state(snapshot())} active />); fireEvent.click(screen.getByRole('button', { name: 'Download report.txt' }));
    await screen.findByText(/no longer available/i); fireEvent.click(screen.getByRole('button', { name: 'Download report.txt' }));
    const link = await screen.findByRole('link', { name: /open.*example.com/i }); expect(link).toHaveAttribute('rel', 'noopener noreferrer'); expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  });
  it('copies the exact displayed text when clipboard is available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<TaskResults state={state(snapshot())} active />); fireEvent.click(screen.getByRole('button', { name: 'Copy displayed text' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Review complete.\n<script>literal</script>'));
  });
});
