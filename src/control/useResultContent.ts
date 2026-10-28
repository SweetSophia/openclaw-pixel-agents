import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ControlTarget } from '../../shared/control';
import { CONTROL_RESULT_LIMITS, type ControlArtifactScope, type ControlExternalFile } from '../../shared/controlResults';
import { useControlAccess } from './ControlAccess';
import { ControlApiError, targetIdentity } from './api';

type Preview = null | { artifactId: string; kind: 'text'; text: string; truncated: boolean }
  | { artifactId: string; kind: 'image'; url: string; mimeType: string };
export interface ResultContentState {
  loadingId: string | null; error: ControlApiError | null; external: ControlExternalFile | null; preview: Preview;
  act(artifactId: string, intent: 'preview' | 'download'): Promise<void>; clear(): void;
}
const empty = { loadingId: null, error: null, external: null, preview: null };
export function useResultContent(options: { target: ControlTarget | null; scope: ControlArtifactScope | null; sourceRevision?: string; active: boolean; current: boolean; historical?: boolean }): ResultContentState {
  const access = useControlAccess(); const [view, setView] = useState<Omit<ResultContentState, 'act' | 'clear'>>(empty);
  const revision = useRef(0); const pending = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>()); const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const context = useRef({ options, access }); context.current = { options, access };
  const clear = useCallback(() => {
    revision.current++; pending.current?.abort(); pending.current = null;
    for (const timer of timers.current) clearTimeout(timer); timers.current.clear();
    for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear(); setView(empty);
  }, []);
  const identity = JSON.stringify([options.target && targetIdentity(options.target), options.scope, options.sourceRevision, options.active, options.current, options.historical,
    access.generation, access.state, access.status?.canRead, access.status?.state]);
  useLayoutEffect(() => { clear(); return clear; }, [identity, clear]);
  useEffect(() => {
    const change = () => { if (document.visibilityState === 'hidden') clear(); };
    document.addEventListener('visibilitychange', change); return () => document.removeEventListener('visibilitychange', change);
  }, [clear]);
  const act = useCallback(async (artifactId: string, intent: 'preview' | 'download') => {
    const { options: selected, access: owner } = context.current;
    if (!selected.active || !selected.current || !selected.target || !selected.scope || owner.state !== 'unlocked' || !owner.status?.canRead || document.visibilityState === 'hidden') return;
    clear(); const current = revision.current; const controller = new AbortController(); pending.current = controller;
    const timer = setTimeout(() => controller.abort(), CONTROL_RESULT_LIMITS.contentDeadlineMs);
    const valid = () => current === revision.current && !controller.signal.aborted;
    setView({ ...empty, loadingId: artifactId });
    try {
      const value = await owner.requestFile(`/api/control/agents/${encodeURIComponent(selected.target.agentId)}/results/file`, {
        method: 'POST', signal: controller.signal, body: JSON.stringify({ target: selected.target, scope: selected.scope, artifactId, intent, ...(selected.historical ? { historical: true } : {}) }) });
      if (!valid()) return;
      if (value.kind === 'external') { setView({ ...empty, external: value }); return; }
      if (intent === 'download') {
        const url = URL.createObjectURL(value.blob); urls.current.add(url);
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = value.filename; anchor.hidden = true;
        document.body.append(anchor); try { anchor.click(); } finally { anchor.remove(); }
        const release = setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); timers.current.delete(release); }, 1000); timers.current.add(release);
        setView(empty); return;
      }
      const mime = value.blob.type.split(';')[0].trim().toLowerCase();
      if (mime === 'text/plain' && value.blob.size <= CONTROL_RESULT_LIMITS.previewBytes) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await value.blob.arrayBuffer());
        if (valid()) setView({ ...empty, preview: { artifactId, kind: 'text', text, truncated: value.truncated } });
      } else if (['image/png', 'image/jpeg', 'image/webp'].includes(mime) && value.blob.size <= CONTROL_RESULT_LIMITS.imageBytes) {
        const url = URL.createObjectURL(value.blob); urls.current.add(url);
        setView({ ...empty, preview: { artifactId, kind: 'image', url, mimeType: mime } });
      } else throw new ControlApiError('preview-unsupported');
    } catch (error) {
      if (valid()) setView({ ...empty, error: error instanceof ControlApiError ? error : new ControlApiError('preview-unsupported') });
    } finally {
      clearTimeout(timer); if (pending.current === controller) {
        pending.current = null; if (current === revision.current) setView(old => ({ ...old, loadingId: null, ...(controller.signal.aborted ? { error: new ControlApiError() } : {}) }));
      }
    }
  }, [clear]);
  return { ...view, act, clear };
}
