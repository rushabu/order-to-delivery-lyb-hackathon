// Check 4: history totals match the target table cell by cell, and the cause counts match.
import { describe, expect, it } from 'vitest';
import { istParts } from '../scripts/seed-lib';
import { history } from './helpers';

const TARGET: [string, string, number, number][] = [
  ['RTE-01', 'TRN-01', 12, 10],
  ['RTE-01', 'TRN-02', 10, 7],
  ['RTE-02', 'TRN-01', 9, 7],
  ['RTE-02', 'TRN-02', 9, 4],
];
const count = (rows: any[]) => [rows.length, rows.filter((h) => h.on_time).length];

describe('history totals', () => {
  it.each(TARGET)('%s with %s: %i shipments, %i on time', (route, trn, n, ok) => {
    expect(count(history.filter((h) => h.route_id === route && h.transporter_id === trn))).toEqual([n, ok]);
  });

  it('route, transporter and overall totals', () => {
    expect(count(history.filter((h) => h.route_id === 'RTE-01'))).toEqual([22, 17]);
    expect(count(history.filter((h) => h.route_id === 'RTE-02'))).toEqual([18, 11]);
    expect(count(history.filter((h) => h.transporter_id === 'TRN-01'))).toEqual([21, 17]);
    expect(count(history.filter((h) => h.transporter_id === 'TRN-02'))).toEqual([19, 11]);
    expect(count(history)).toEqual([40, 28]);
  });

  it('primary cause counts', () => {
    const counts: Record<string, number> = {};
    for (const h of history.filter((x) => !x.on_time)) counts[h.primary_cause] = (counts[h.primary_cause] ?? 0) + 1;
    expect(counts).toEqual({ CONGESTION: 4, ACCIDENT: 2, BREAKDOWN: 2, WEATHER: 2, LOADING_DELAY: 1, ROAD_CLOSURE: 1 });
  });

  it('breakdowns are all Konkan Roadlines, weather is all RTE-02', () => {
    const late = history.filter((h) => !h.on_time);
    expect(new Set(late.filter((h) => h.primary_cause === 'BREAKDOWN').map((h) => h.transporter_id))).toEqual(new Set(['TRN-02']));
    expect(new Set(late.filter((h) => h.primary_cause === 'WEATHER').map((h) => h.route_id))).toEqual(new Set(['RTE-02']));
  });

  it('natural ranges', () => {
    const late = history.filter((h) => !h.on_time).map((h) => h.lateness_min);
    const early = history.filter((h) => h.on_time).map((h) => -h.lateness_min);
    expect([Math.min(...late), Math.max(...late)]).toEqual([12, 140]);
    expect([Math.min(...early), Math.max(...early)]).toEqual([5, 50]);
    expect(history.every((h) => h.quantity_t >= 16 && h.quantity_t <= 28)).toBe(true);
    const local = history.map((h) => istParts(h.planned_departure));
    expect(local.every((p) => p.weekday !== 0)).toBe(true);
    expect(local.every((p) => p.date >= '2026-10-17' && p.date <= '2026-11-15')).toBe(true);
    expect(local.every((p) => p.hhmm >= '06:00' && p.hhmm <= '10:45')).toBe(true);
    expect(new Set(history.map((h) => h.vehicle_id)).size).toBeGreaterThanOrEqual(5);
    expect(new Set(history.map((h) => h.driver_user_id)).size).toBe(3);
  });
});
