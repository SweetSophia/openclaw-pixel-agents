// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadControlConfig } from './config';
import { loadScheduleConfig } from './scheduleConfig';

const control = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'wss://fixture.invalid/socket', PIXEL_CONTROL_TOKEN: 'fixture-access', OPENCLAW_GATEWAY_TOKEN: 'ordinary-bootstrap' }, '/tmp/schedule-config-fixture');
describe('separate scheduling configuration', () => {
  it('requires exact opt-in and an enabled ordinary reader', () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      expect(loadScheduleConfig({ CONTROL_SCHEDULES_MANAGE_ENABLED: value }, '/tmp/fixture', control)).toEqual({ enabled: false, deviceDirectory: '/tmp/fixture/control-schedules' });
    }
    expect(loadScheduleConfig({ CONTROL_SCHEDULES_MANAGE_ENABLED: 'true' }, '/tmp/fixture', loadControlConfig({}, '/tmp/fixture')).enabled).toBe(false);
  });
  it('uses the validated reader endpoint but never ordinary bootstrap credentials or flags', () => {
    expect(loadScheduleConfig({ CONTROL_SCHEDULES_MANAGE_ENABLED: 'true', OPENCLAW_GATEWAY_TOKEN: 'ordinary-bootstrap', OPENCLAW_GATEWAY_PASSWORD: 'ordinary-password', CONTROL_SEND_ENABLED: 'true', CONTROL_APPROVALS_ENABLED: 'true' }, '/tmp/fixture', control)).toEqual({ enabled: true, url: 'wss://fixture.invalid/socket', deviceDirectory: '/tmp/fixture/control-schedules', token: undefined, password: undefined });
    expect(loadScheduleConfig({ CONTROL_SCHEDULES_MANAGE_ENABLED: 'true', OPENCLAW_SCHEDULES_GATEWAY_TOKEN: 'schedule-bootstrap', OPENCLAW_SCHEDULES_GATEWAY_PASSWORD: 'schedule-password' }, '/tmp/fixture', control)).toMatchObject({ token: 'schedule-bootstrap', password: 'schedule-password' });
  });
});
