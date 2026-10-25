// Private reads share cancellation bounds; message submissions own separate outcome handling.
export function controlReadDeadline(controller: AbortController, parent?: AbortSignal): () => void {
  const abort = () => controller.abort();
  const timer = setTimeout(abort, 10000);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); };
}
