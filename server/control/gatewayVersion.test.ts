import { describe, expect, it } from 'vitest';
import { supportsStableGatewayVersion } from './gatewayVersion';

describe('stable Gateway version qualification', () => {
  it.each(['2026.11.2', '2026.11.2+build.1', '2026.11.3', '2026.12.0', '2027.1.0'])('accepts qualified stable %s', version => {
    expect(supportsStableGatewayVersion(version, '2026.11.2')).toBe(true);
  });
  it.each(['', 'fixture', 'v2026.11.2', '2026.11', '2026.011.2', '2026.11.1', '2026.10.99', '2026.11.2-beta.1', '2027.1.0-rc.1', '9007199254740992.1.0', '2026.11.2+'])('rejects unqualified %j', version => {
    expect(supportsStableGatewayVersion(version, '2026.11.2')).toBe(false);
  });
  it('does not invent a minimum for a malformed policy version', () => {
    expect(supportsStableGatewayVersion('2027.1.0', '2026.11.2-beta.1')).toBe(false);
  });
});
