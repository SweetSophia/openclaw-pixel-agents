import { ControlApiError } from './api';

class ReadTimeoutError extends ControlApiError {
  constructor() { super('unavailable'); this.message = 'The request timed out. Try again.'; }
}
// Private reads share cancellation bounds; message submissions own separate outcome handling.
export function controlReadDeadline(controller: AbortController, parent?: AbortSignal, milliseconds = 10000): () => void {
  const abort = () => controller.abort(parent?.reason);
  const timer = setTimeout(() => controller.abort(new ReadTimeoutError()), milliseconds);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); };
}
export function controlReadError(controller: AbortController, error?: unknown): ControlApiError {
  if (controller.signal.aborted) return controller.signal.reason instanceof ReadTimeoutError ? new ReadTimeoutError() : new ControlApiError('unavailable');
  return error instanceof ControlApiError ? error : new ControlApiError();
}
