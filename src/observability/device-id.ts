import { createHash } from 'node:crypto';
import { arch, hostname, networkInterfaces, platform, userInfo } from 'node:os';

export function computeDeviceId(): string {
  const macs: string[] = [];
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (!i.internal && i.mac && i.mac !== '00:00:00:00:00:00') macs.push(i.mac);
    }
  }
  let username = 'unknown-user';
  try {
    username = userInfo().username;
  } catch {
    // restricted container environment
  }
  const parts = [hostname(), platform(), arch(), username, macs[0] ?? 'no-mac'];
  return `anon_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)}`;
}

export function deviceIdOrAnon(telemetryEnabled: boolean): string {
  return telemetryEnabled ? computeDeviceId() : 'anon_disabled';
}
