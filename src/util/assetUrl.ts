declare const __ASSET_BUILD_ID__: string;

/** Public assets share a build revision so reloads can reuse the browser cache. */
export function assetUrl(path: string): string {
  const revision = typeof __ASSET_BUILD_ID__ === 'undefined' ? '' : __ASSET_BUILD_ID__;
  return revision ? `${path}${path.includes('?') ? '&' : '?'}v=${revision}` : path;
}
