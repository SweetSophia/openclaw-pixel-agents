import { describe, expect, it } from 'vitest';
import { isControlModelId, modelTargetIdentity, parseModelTarget, parseControlModelReadRequest, parseControlModelSelection, parseControlModelSnapshot, parseControlModelOutcome } from './controlModels';

const target = { agentId: 'cylena', sessionKey: 'agent:cylena:fixture', sessionId: 's1', lifecycleRevision: 'l1', branchId: 'b1' };
const snapshot = { target, selectionId: 'observation', observedAt: 100, currentModel: 'provider/model', choices: [{ id: 'provider/model', label: 'Model 🧪', selectable: true, available: null }], canChange: true, disabledReason: null };
describe('closed private model contract', () => {
  it('accepts literal canonical selections and rejects metadata at both request boundaries', () => {
    expect(parseControlModelReadRequest({ target })).toEqual({ target });
    expect(parseControlModelSelection({ target, selectionId: 'o1', model: null })).toEqual({ target, selectionId: 'o1', model: null });
    for (const extra of [{ runId: 'run1' }, { name: 'private' }, { hasActiveRun: false }, { model: 'provider/model' }]) {
      expect(parseModelTarget({ ...target, ...extra })).toBeNull();
      expect(parseControlModelReadRequest({ target, ...extra })).toBeNull();
    }
    expect(modelTargetIdentity(target)).toBe(modelTargetIdentity({ ...target, activeLeafEntryId: 'append' }));
    expect(modelTargetIdentity(target)).not.toBe(modelTargetIdentity({ ...target, branchId: 'new' }));
  });
  it('preserves unambiguous Unicode but rejects controls, bidi, malformed Unicode and overlong identifiers', () => {
    expect(isControlModelId('provider/模型🧪')).toBe(true);
    expect(isControlModelId('x'.repeat(512))).toBe(true);
    for (const id of ['', ' a', 'a ', 'a\n', 'a\u0085', 'a\u202e', 'a\u061c', 'a\u2069', 'a\ud800', 'a\udfff', 'x'.repeat(513)]) {
      expect(isControlModelId(id)).toBe(false);
      expect(parseControlModelSelection({ target, selectionId: 'o1', model: id })).toBeNull();
    }
    expect(parseModelTarget({ ...target, branchId: 'b\u202e' })).toBeNull();
    expect(parseControlModelSelection({ target, selectionId: 'x'.repeat(129), model: null })).toBeNull();
  });
  it('bounds choices and validates policy separately from readiness without leaking source fields', () => {
    expect(parseControlModelSnapshot(snapshot)).toEqual(snapshot);
    for (const patch of [{ path: '/private' }, { choices: [...snapshot.choices, ...snapshot.choices] },
      { choices: [{ ...snapshot.choices[0], label: 'x'.repeat(129) }] }, { choices: [{ ...snapshot.choices[0], available: 'yes' }] },
      { canChange: true, disabledReason: 'busy' }, { currentModel: 'bad\u202e' }, { observedAt: Infinity },
      { choices: Array.from({ length: 501 }, (_, i) => ({ ...snapshot.choices[0], id: `p/${i}` })) }]) expect(parseControlModelSnapshot({ ...snapshot, ...patch })).toBeNull();
    expect(parseControlModelSnapshot({ ...snapshot, canChange: false, disabledReason: 'read-only' })).not.toBeNull();
    expect(parseControlModelOutcome({ target, outcome: 'confirmed' })).toBeNull();
    expect(parseControlModelOutcome({ target, outcome: 'confirmed', snapshot })).not.toBeNull();
    expect(parseControlModelOutcome({ target, outcome: 'confirmed', snapshot: { ...snapshot, target: { ...target, sessionId: 'other' } } })).toBeNull();
    expect(parseControlModelOutcome({ target, outcome: 'unknown' })).toEqual({ target, outcome: 'unknown' });
  });
  it('never accepts an actionable snapshot without an observed current selection', () => {
    expect(parseControlModelSnapshot({ ...snapshot, currentModel: null })).toBeNull();
    expect(parseControlModelSnapshot({ ...snapshot, currentModel: null, canChange: false, disabledReason: 'selection-unknown' })).not.toBeNull();
  });
  it('rejects native auth-profile selectors without consuming safe date and quantization model suffixes', () => {
    for (const id of ['p/model@account', 'p/model@20261030@account', 'p/model@q4_k_m@account', 'p/model@20261030@q4_k_m@account', 'p/model@q4@20261030', 'p/@account']) {
      expect(isControlModelId(id)).toBe(false);
      expect(parseControlModelSelection({ target, selectionId: 'o1', model: id })).toBeNull();
    }
    for (const id of ['p/model@20261030', 'p/model@q4_k_m', 'p/model@IQ4_XS', 'p/model@4bit', 'p/model@20261030@q4_k_m', 'p/nested@literal/model']) expect(isControlModelId(id)).toBe(true);
  });
});
