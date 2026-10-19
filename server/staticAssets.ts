import type { ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';

/** Only explicitly versioned static assets may survive a browser reload. */
export function assetCacheHeaders(assetsDir: string) {
  const assetPrefix = resolve(assetsDir) + sep;
  return (res: ServerResponse, filePath: string): void => {
    const query = (res.req.url ?? '').split('?')[1] ?? '';
    const revision = new URLSearchParams(query).get('v') ?? '';
    // Check the file selected by express.static, including decoded path traversal.
    if (filePath.startsWith(assetPrefix) && /^[a-f0-9]{32}$/.test(revision)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  };
}
