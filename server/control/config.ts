import { join } from 'node:path';

export interface ControlConfig {
  enabled: boolean; url?: string; controlToken?: string; token?: string; password?: string;
  deviceDirectory: string; sendEnabled: boolean; allowTailnetHttp: boolean;
}
export function loadControlConfig(env: NodeJS.ProcessEnv, dataDir: string): ControlConfig {
  const url = env.OPENCLAW_GATEWAY_URL?.trim();
  const controlToken = env.PIXEL_CONTROL_TOKEN;
  const config: ControlConfig = {
    enabled: Boolean(url && controlToken), deviceDirectory: join(dataDir, 'control'),
    sendEnabled: env.CONTROL_SEND_ENABLED === 'true', allowTailnetHttp: env.CONTROL_ALLOW_TAILNET_HTTP === 'true',
  };
  if (!config.enabled) return config;
  let endpoint: URL;
  try { endpoint = new URL(url!); } catch { throw Error('Invalid task Gateway endpoint'); }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(endpoint.hostname);
  if ((endpoint.protocol !== 'wss:' && !(endpoint.protocol === 'ws:' && loopback))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Invalid task Gateway endpoint');
  return { ...config, url: endpoint.href, controlToken, token: env.OPENCLAW_GATEWAY_TOKEN, password: env.OPENCLAW_GATEWAY_PASSWORD };
}
