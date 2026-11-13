// Deterministic UUIDs for events the server creates itself (seed and simulator), so that two replays
// after a reset produce identical rows. Formatted as version-4 UUIDs so they pass the same validation.
import { createHash } from 'node:crypto';

export function stableUuid(name: string): string {
  const h = createHash('sha256').update(name).digest('hex');
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
