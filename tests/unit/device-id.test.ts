import { describe, expect, it } from 'vitest';
import { computeDeviceId, deviceIdOrAnon } from '../../src/observability/device-id.js';

describe('device id', () => {
  it('稳定且以 anon_ 开头', () => {
    const a = computeDeviceId();
    const b = computeDeviceId();
    expect(a).toBe(b);
    expect(a.startsWith('anon_')).toBe(true);
  });
  it('telemetry off 返回 anon_disabled', () => {
    expect(deviceIdOrAnon(false)).toBe('anon_disabled');
  });
});
