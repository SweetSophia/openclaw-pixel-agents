import { join } from 'node:path';
import type { ControlConfig } from './config';

export interface ScheduleConfig {
  enabled: boolean; url?: string; deviceDirectory: string; token?: string; password?: string;
}
export function loadScheduleConfig(env: NodeJS.ProcessEnv, dataDir: string, control: ControlConfig): ScheduleConfig {
  const config: ScheduleConfig = {
    enabled: env.CONTROL_SCHEDULES_MANAGE_ENABLED === 'true' && control.enabled,
    deviceDirectory: join(dataDir, 'control-schedules'),
  };
  if (!config.enabled) return config;
  return { ...config, url: control.url, token: env.OPENCLAW_SCHEDULES_GATEWAY_TOKEN, password: env.OPENCLAW_SCHEDULES_GATEWAY_PASSWORD };
}
