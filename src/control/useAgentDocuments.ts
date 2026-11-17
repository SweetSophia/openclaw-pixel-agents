import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AGENT_DOCUMENT_NAMES, isAgentDocumentText, parseAgentDocumentManagement, parseAgentDocumentSaveReceipt, parseAgentDocumentSnapshot,
  type AgentDocumentManagement, type AgentDocumentName, type AgentDocumentSaveReceipt, type AgentDocumentSnapshot } from '../../shared/controlAgentDocuments';
import { useControlAccess } from './ControlAccess';
import { ControlApiError } from './api';
import { newEntityId } from '../util/id';

interface View {
  management: AgentDocumentManagement | null; selected: AgentDocumentName | null; snapshot: AgentDocumentSnapshot | null;
  draft: string; loading: boolean; saving: boolean; saveNeedsReview: boolean; error: ControlApiError | null; receipt: AgentDocumentSaveReceipt | null; epoch: string | null;
}
const empty: View = { management: null, selected: null, snapshot: null, draft: '', loading: false, saving: false, saveNeedsReview: false, error: null, receipt: null, epoch: null };
export function useAgentDocuments(options: { agentId: string; active: boolean; opened: boolean }) {
  const access = useControlAccess(); const owner = `${options.agentId}:${access.generation}`;
  const [view, render] = useState<View>(empty); const data = useRef(view); const identity = useRef(owner);
  const context = useRef({ options, access, owner }); context.current = { options, access, owner };
  const mounted = useRef(true); const serial = useRef(0); const controllers = useRef(new Set<AbortController>());
  const draftVersion = useRef(0);
  const update = useCallback((change: Partial<View>) => { data.current = { ...data.current, ...change }; if (mounted.current) render(data.current); }, []);
  const permitted = () => mounted.current && context.current.options.active && context.current.options.opened
    && context.current.access.state === 'unlocked' && context.current.access.status?.canRead === true && document.visibilityState !== 'hidden';
  const invalidate = useCallback(() => {
    serial.current++; for (const controller of controllers.current) controller.abort(); controllers.current.clear();
    update({ epoch: null, loading: false, saving: false,
      ...(data.current.saving ? { error: new ControlApiError('document-outcome-unknown') } : {}) });
  }, [update]);
  const reset = useCallback(() => { invalidate(); update(empty); }, [invalidate, update]);
  // Race the deadline as well as aborting fetch: even an uncooperative transport cannot keep Save pending.
  const request = useCallback(async (suffix: string, body?: unknown) => {
    const authority = context.current.access; const agentId = context.current.options.agentId;
    const controller = new AbortController(); controllers.current.add(controller);
    const timer = setTimeout(() => controller.abort(), 15000);
    let cancel!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new ControlApiError('timed-out')); controller.signal.addEventListener('abort', cancel, { once: true });
    });
    try { return await Promise.race([authority.request(`/api/control/agents/${encodeURIComponent(agentId)}/documents/${suffix}`,
      { signal: controller.signal, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) }), stopped]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', cancel); controllers.current.delete(controller); }
  }, []);
  const refreshManagement = useCallback(async () => {
    if (!permitted()) return null;
    const current = serial.current; const target = context.current.owner;
    try {
      const management = parseAgentDocumentManagement(await request('status'));
      if (!management) throw new ControlApiError('invalid-source');
      if (current !== serial.current || target !== context.current.owner || !permitted()) return null;
      if (!management.canEdit || (data.current.management?.epoch && management.epoch !== data.current.management.epoch)) invalidate();
      update({ management }); return management;
    } catch (error) {
      if (current === serial.current && target === context.current.owner && permitted()) {
        const saving = data.current.saving;
        invalidate(); update({ management: null, error: saving ? new ControlApiError('document-outcome-unknown') : error instanceof ControlApiError ? error : new ControlApiError() });
      }
      return null;
    }
  }, [invalidate, request, update]);
  const read = useCallback(async (name: AgentDocumentName) => {
    if (!permitted() || !AGENT_DOCUMENT_NAMES.includes(name)) return;
    invalidate(); const current = serial.current; const target = context.current.owner; const textVersion = draftVersion.current;
    update({ selected: name, loading: true, error: null, receipt: null });
    const valid = () => current === serial.current && target === context.current.owner && permitted();
    try {
      const before = await refreshManagement(); if (!before?.canEdit || !valid()) return;
      const snapshot = parseAgentDocumentSnapshot(await request('read', { name }));
      if (!snapshot || snapshot.agentId !== context.current.options.agentId || snapshot.name !== name || snapshot.source.state !== 'current') throw new ControlApiError('invalid-source');
      if (!valid()) return;
      const after = await refreshManagement();
      if (!valid() || !after?.canEdit || before.epoch !== after.epoch) return;
      if (draftVersion.current !== textVersion) return;
      update({ snapshot, draft: snapshot.content, epoch: after.epoch, error: null, saveNeedsReview: false });
    } catch (error) { if (valid()) update({ error: error instanceof ControlApiError ? error : new ControlApiError('invalid-source'), epoch: null }); }
    finally { if (valid()) update({ loading: false }); }
  }, [invalidate, refreshManagement, request, update]);
  const select = useCallback(async (name: AgentDocumentName) => {
    if (!permitted() || !data.current.management?.canEdit || data.current.saving) return;
    update({ snapshot: null, draft: '', epoch: null, saveNeedsReview: false }); await read(name);
  }, [read, update]);
  const reload = useCallback(async () => { if (data.current.selected && !data.current.saving) await read(data.current.selected); }, [read]);
  const setDraft = useCallback((draft: string) => { draftVersion.current++; update({ draft }); }, [update]);
  const readyToSave = () => {
    const value = data.current;
    return permitted() && !!value.snapshot && value.draft !== value.snapshot.content && isAgentDocumentText(value.draft)
      && !value.loading && !value.saving && !!value.epoch && value.management?.canEdit === true && value.epoch === value.management.epoch;
  };
  const save = useCallback(async () => {
    if (!readyToSave()) return;
    const value = data.current; const snapshot = value.snapshot!; const draft = value.draft; const epoch = value.epoch;
    const target = context.current.owner; const current = serial.current;
    const submission = { name: snapshot.name, revision: snapshot.revision, operationId: newEntityId('document'), content: draft };
    update({ saving: true, error: null, receipt: null, epoch: null });
    const valid = () => current === serial.current && target === context.current.owner && permitted() && data.current.selected === submission.name;
    try {
      const management = await refreshManagement();
      if (!valid() || !management?.canEdit || management.epoch !== epoch) return;
      // An undo to the old snapshot cannot prove the draft matches an outstanding or uncertain write.
      update({ saveNeedsReview: true });
      const receipt = parseAgentDocumentSaveReceipt(await request('save', submission));
      if (!valid()) return;
      if (!receipt || receipt.agentId !== snapshot.agentId || receipt.name !== submission.name || receipt.operationId !== submission.operationId
        || (receipt.state === 'saved' && (receipt.snapshot?.content !== draft || receipt.snapshot?.source.state !== 'current'))) throw new ControlApiError('document-outcome-unknown');
      const after = await refreshManagement();
      if (!valid() || !after?.canEdit || after.epoch !== epoch) return;
      if (receipt.state === 'saved') update({ snapshot: receipt.snapshot!, receipt, saveNeedsReview: false, epoch: data.current.draft === draft ? after.epoch : null });
      else update({ receipt, error: receipt.state === 'conflict' ? new ControlApiError('document-changed') : receipt.state === 'unknown' ? new ControlApiError('document-outcome-unknown') : null });
    } catch (error) {
      if (valid()) update({ error: error instanceof ControlApiError && ['document-denied', 'document-changed'].includes(error.code) ? error : new ControlApiError('document-outcome-unknown') });
    } finally { if (valid()) update({ saving: false }); }
  }, [refreshManagement, request, update]);
  useLayoutEffect(() => {
    identity.current = owner; reset();
  }, [owner, access.state, reset]);
  useEffect(() => {
    if (!permitted()) {
      invalidate();
      if (options.opened && data.current.management?.configured) update({ management: { configured: true,
        state: 'unavailable', canEdit: false, epoch: null, reason: 'unavailable' } });
      return;
    }
    void refreshManagement(); const timer = setInterval(() => { void refreshManagement(); }, 5000);
    return () => { clearInterval(timer); invalidate(); };
  }, [owner, options.active, options.opened, access.state, access.status?.canRead, refreshManagement, invalidate, update]);
  useEffect(() => {
    mounted.current = true;
    const visibility = () => { invalidate(); if (document.visibilityState !== 'hidden') void refreshManagement(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { mounted.current = false; invalidate(); data.current = empty; document.removeEventListener('visibilitychange', visibility); };
  }, [invalidate, refreshManagement]);
  const shown = identity.current === owner && access.state === 'unlocked' ? view : empty;
  return { ...shown, dirty: !!shown.snapshot && (shown.saveNeedsReview || shown.draft !== shown.snapshot.content), valid: isAgentDocumentText(shown.draft),
    bytes: new TextEncoder().encode(shown.draft).byteLength, canSave: shown === view && readyToSave(), select, setDraft, reload, save, reset, refreshManagement };
}
