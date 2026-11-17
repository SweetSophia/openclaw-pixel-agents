import { join } from 'node:path';
import type { ControlConfig } from './config';

export interface AgentDocumentConfig { enabled: boolean; url?: string; deviceDirectory: string; token?: string; password?: string }
export function loadAgentDocumentConfig(env: NodeJS.ProcessEnv, dataDir: string, control: ControlConfig): AgentDocumentConfig {
  const config: AgentDocumentConfig = { enabled: env.CONTROL_DOCUMENTS_EDIT_ENABLED === 'true' && control.enabled, deviceDirectory: join(dataDir, 'control-documents') };
  if (!config.enabled) return config;
  return { ...config, url: control.url, token: env.OPENCLAW_DOCUMENTS_GATEWAY_TOKEN, password: env.OPENCLAW_DOCUMENTS_GATEWAY_PASSWORD };
}
