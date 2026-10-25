import { afterEach, expect, it, vi } from 'vitest';
import { ControlApiError } from './api';
import { controlReadDeadline, controlReadError } from './readDeadline';

afterEach(() => vi.useRealTimers());
it('gives an expired read a machine-readable timeout identity', () => {
  vi.useFakeTimers(); const controller = new AbortController(); const dispose = controlReadDeadline(controller, undefined, 25);
  vi.advanceTimersByTime(24); expect(controller.signal.aborted).toBe(false);
  vi.advanceTimersByTime(1); const error = controlReadError(controller);
  expect(error.code).toBe('timed-out'); expect(error.message).toMatch(/timed out/i); dispose();
});
it('does not label ordinary cancellation as a timeout', () => {
  const controller = new AbortController(); controller.abort();
  const error = controlReadError(controller, new ControlApiError('invalid-source'));
  expect(error.code).toBe('unavailable'); expect(error.message).not.toMatch(/timed out/i);
});
it('preserves a typed failure when the request was not aborted', () => {
  const error = new ControlApiError('session-changed'); expect(controlReadError(new AbortController(), error)).toBe(error);
});
it('normalizes an untyped rejection without claiming a timeout', () => {
  const error = controlReadError(new AbortController(), Error('offline'));
  expect(error).toBeInstanceOf(ControlApiError); expect(error.code).toBe('unavailable'); expect(error.message).not.toMatch(/timed out/i);
});
it('propagates a parent cancellation reason and disposes unused timers', () => {
  vi.useFakeTimers(); const parent = new AbortController(); const child = new AbortController();
  const dispose = controlReadDeadline(child, parent.signal, 25); parent.abort('lifecycle');
  expect(child.signal.reason).toBe('lifecycle'); expect(controlReadError(child).code).toBe('unavailable'); dispose();
  const unused = new AbortController(); controlReadDeadline(unused, undefined, 25)();
  vi.advanceTimersByTime(25); expect(unused.signal.aborted).toBe(false);
});
