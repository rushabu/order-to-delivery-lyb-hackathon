// Delay-cause attribution for an arrived shipment: for each cause, the largest number of minutes it
// added in any of the shipment's ETA snapshots ("how much it was predicted to cost at its worst").
import type { Db } from '../db/db';

const NOT_CAUSES = new Set(['BASE_TRAVEL', 'DWELL', 'POSITION_STALE', 'SCHEDULE_FALLBACK', 'DEPARTURE_WAIT']);

export function recordDelayCauses(db: Db, shipmentId: string): void {
  const rows = db.prepare('SELECT factors FROM eta_snapshots WHERE shipment_id = ?').all(shipmentId) as { factors: string }[];
  const peak = new Map<string, number>();
  for (const r of rows) {
    for (const f of JSON.parse(r.factors) as { code: string; minutes: number }[]) {
      if (NOT_CAUSES.has(f.code) || f.minutes <= 0) continue;
      peak.set(f.code, Math.max(peak.get(f.code) ?? 0, f.minutes));
    }
  }
  db.prepare('DELETE FROM shipment_delay_causes WHERE shipment_id = ?').run(shipmentId);
  const ins = db.prepare('INSERT INTO shipment_delay_causes (shipment_id, cause, minutes) VALUES (?, ?, ?)');
  for (const [cause, minutes] of [...peak.entries()].sort()) ins.run(shipmentId, cause, minutes);
}
