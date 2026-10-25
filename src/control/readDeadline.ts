import { ControlApiError } from './api';

// Private reads share cancellation bounds; message submissions own separate outcome handling.
export function controlReadDeadline(controller: AbortController, parent?: AbortSignal, milliseconds = 10000): () => void {
  const abort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new ControlApiError('timed-out')), milliseconds);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); };
}
export function controlReadError(controller: AbortController, error?: unknown): ControlApiError {
  if (controller.signal.aborted) return new ControlApiError(controller.signal.reason instanceof ControlApiError && controller.signal.reason.code === 'timed-out' ? 'timed-out' : 'unavailable');
  return error instanceof ControlApiError ? error : new ControlApiError();
}
