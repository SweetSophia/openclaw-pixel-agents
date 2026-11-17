// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { loadControlConfig } from './config';
import { loadAgentDocumentConfig } from './agentDocumentConfig';

const control = loadControlConfig({ OPENCLAW_GATEWAY_URL: 'wss://fixture.invalid/socket', PIXEL_CONTROL_TOKEN: 'fixture-access', OPENCLAW_GATEWAY_TOKEN: 'ordinary-bootstrap' }, '/tmp/document-config-fixture');
describe('isolated default-off document configuration', () => {
  it('does not create authority from credentials without exact opt-in and private access', () => {
    for (const enabled of [undefined, 'false', 'TRUE', '1']) expect(loadAgentDocumentConfig({ CONTROL_DOCUMENTS_EDIT_ENABLED: enabled, OPENCLAW_DOCUMENTS_GATEWAY_TOKEN: 'document-token' }, '/tmp/fixture', control)).toEqual({ enabled: false, deviceDirectory: '/tmp/fixture/control-documents' });
    expect(loadAgentDocumentConfig({ CONTROL_DOCUMENTS_EDIT_ENABLED: 'true' }, '/tmp/fixture', loadControlConfig({}, '/tmp/fixture')).enabled).toBe(false);
  });
  it('uses only document bootstrap secrets and the validated endpoint', () => {
    const env = { CONTROL_DOCUMENTS_EDIT_ENABLED: 'true', OPENCLAW_GATEWAY_TOKEN: 'ordinary', OPENCLAW_GATEWAY_PASSWORD: 'ordinary-password', OPENCLAW_SCHEDULES_GATEWAY_TOKEN: 'schedule', OPENCLAW_SCHEDULES_GATEWAY_PASSWORD: 'schedule-password' };
    expect(loadAgentDocumentConfig(env, '/tmp/fixture', control)).toEqual({ enabled: true, url: 'wss://fixture.invalid/socket', deviceDirectory: '/tmp/fixture/control-documents', token: undefined, password: undefined });
    expect(loadAgentDocumentConfig({ ...env, OPENCLAW_DOCUMENTS_GATEWAY_TOKEN: 'documents', OPENCLAW_DOCUMENTS_GATEWAY_PASSWORD: 'documents-password' }, '/tmp/fixture', control)).toMatchObject({ token: 'documents', password: 'documents-password' });
  });
});
