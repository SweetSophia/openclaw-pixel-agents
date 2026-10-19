import { assetUrl } from './assetUrl';

/** Decode an asset, releasing a late bitmap when its caller has cancelled. */
export async function loadPng(path: string, signal?: AbortSignal): Promise<ImageBitmap> {
  signal?.throwIfAborted();
  const response = await fetch(assetUrl(path), { signal });
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  if (signal?.aborted) bitmap.close();
  signal?.throwIfAborted();
  return bitmap;
}
