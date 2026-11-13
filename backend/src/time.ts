// Small time helpers. All timestamps are ISO 8601 UTC strings with a Z suffix and no milliseconds.

export const MIN_MS = 60_000;

export function toIso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseIso(iso: string): number {
  return Date.parse(iso);
}

export function addMinutes(iso: string, minutes: number): string {
  return toIso(parseIso(iso) + minutes * MIN_MS);
}

/** Whole or fractional minutes from a to b (b - a). */
export function minutesBetween(a: string, b: string): number {
  return (parseIso(b) - parseIso(a)) / MIN_MS;
}

/** Format as IST clock time, e.g. "11:45 IST", for notification text. */
export function istClock(iso: string): string {
  const d = new Date(parseIso(iso) + 330 * MIN_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} IST`;
}
