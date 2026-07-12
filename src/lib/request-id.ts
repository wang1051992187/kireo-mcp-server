import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newRequestId(): string {
  // time(50 bits as 10 base32 chars) + random(64 bits as 16 hex chars) ≈ 26 chars
  const ms = Date.now();
  let time = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    time = (ALPHABET[n % 32] ?? '0') + time;
    n = Math.floor(n / 32);
  }
  const rand = randomBytes(10).toString('hex').slice(0, 16).toUpperCase();
  return `req_${time}${rand}`;
}
